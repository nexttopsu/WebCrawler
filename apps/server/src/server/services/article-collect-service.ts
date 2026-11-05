import { z } from 'zod'
import { CrawlTaskType } from '../../shared/index.js'
import { keywordField } from '../lib/query.js'
import { listArticlesForCollect } from './article-service.js'
import type { ArticleCollectDetailResultDto, CreateTaskInput, TaskDto } from '../../shared/index.js'

/**
 * 详情补采入口。
 *
 * 文章页的「补采」「批量补采」「按筛选补采」都走这里：
 * 先按 id 或筛选条件找出 `pending` / `failed` 的文章，再按「站点 + 栏目」
 * 拆成若干 `detail` 任务，由执行器在后台逐篇抓取。
 *
 * 之所以拆任务而不是同步抓：抓取可能持续几分钟，任务化之后能复用
 * 暂停 / 取消 / 断点续采 / 日志，也不会卡住 HTTP 请求。
 */

export const articleCollectDetailSchema = z
  .object({
    /** 勾选的文章 id；与筛选条件二选一，同时给出时以 id 为准 */
    ids: z.array(z.number().int().positive()).min(1).max(500).optional(),
    siteId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().optional(),
    keyword: keywordField,
    /** 单次最多补采多少篇，默认 200，上限 500 */
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict()

export type ArticleCollectDetailInput = z.infer<typeof articleCollectDetailSchema>

/** 一次补采最多创建多少个任务，避免误点全选把任务队列刷满。 */
const MAX_TASK_GROUPS = 50

/**
 * 创建补采任务。
 *
 * 必须由运行时注入（`TaskRuntime.createTask`）而不是直接调服务层的
 * `createTask`：后者只写库不入队，任务会永远停在 pending。
 */
export type CollectTaskCreator = (input: CreateTaskInput) => TaskDto

export function collectArticleDetails(
  input: ArticleCollectDetailInput,
  createTask: CollectTaskCreator,
): ArticleCollectDetailResultDto {
  const targets = listArticlesForCollect({
    ...(input.ids?.length ? { ids: input.ids } : {}),
    ...(input.siteId ? { siteId: input.siteId } : {}),
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.keyword ? { keyword: input.keyword } : {}),
    limit: input.limit,
  })

  const groups = new Map<string, { siteId: number; categoryId: number; ids: number[] }>()
  let skipped = 0

  for (const item of targets) {
    // 未关联栏目的文章（指定 URL 采集且没绑栏目）没有可用的规则，不建任务
    if (!item.categoryId) {
      skipped += 1
      continue
    }
    const key = `${item.siteId}:${item.categoryId}`
    const group = groups.get(key)
    if (group) group.ids.push(item.id)
    else groups.set(key, { siteId: item.siteId, categoryId: item.categoryId, ids: [item.id] })
  }

  const tasks: ArticleCollectDetailResultDto['tasks'] = []
  const errors: string[] = []
  let articleCount = 0
  let groupIndex = 0

  for (const group of groups.values()) {
    if (groupIndex >= MAX_TASK_GROUPS) {
      errors.push(`一次最多创建 ${MAX_TASK_GROUPS} 个补采任务，剩余 ${groups.size - groupIndex} 组未提交`)
      break
    }
    groupIndex += 1
    try {
      const task = createTask({
        name: `详情补采 · ${group.ids.length} 篇`,
        siteId: group.siteId,
        type: CrawlTaskType.DETAIL,
        categoryIds: [group.categoryId],
        options: { articleIds: group.ids },
      })
      tasks.push({
        taskId: task.id,
        siteId: group.siteId,
        categoryId: group.categoryId,
        articleCount: group.ids.length,
      })
      articleCount += group.ids.length
    } catch (error) {
      // 单个栏目规则不可用不影响其余栏目，把原因带上让用户能定位
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`站点 #${group.siteId} / 栏目 #${group.categoryId}：${message}`)
      skipped += group.ids.length
    }
  }

  return { articleCount, tasks, skipped, errors }
}
