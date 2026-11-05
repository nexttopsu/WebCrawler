import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import {
  call,
  createCategory,
  createRule,
  createSite,
  json,
  sampleConfig,
  startTestApp,
  stopTestApp,
} from './helpers/app.js'
import { saveCrawledArticle, saveListArticle } from '../../src/server/services/article-service.js'
import { getModels } from '../../src/database/index.js'
import type { ArticleData } from '../../src/shared/index.js'

/**
 * 采集范围（仅列表 / 列表 + 详情）与文章页详情补采。
 *
 * 覆盖：规则里的 collectScope 作为任务默认值、任务显式覆盖、
 * 按 id / 按筛选创建 detail 任务、已采集文章不再重复补采。
 */
describe('采集范围与详情补采', () => {
  let app: H3
  let site: any
  let category: any
  let rule: any
  let pendingIds: number[] = []

  function taskSnapshot(taskId: number): Record<string, any> {
    const row = getModels().crawlTask.findById(taskId)
    expect(row).toBeTruthy()
    return JSON.parse(String(row!.configSnapshot))
  }

  async function createTask(body: Record<string, unknown>): Promise<any> {
    const response = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, categoryIds: [category.id], ...body }),
    )
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    return response.body.data
  }

  beforeAll(async () => {
    app = startTestApp()
    site = await createSite(app, { name: '补采站点', domain: 'example.com' })
    category = await createCategory(app, {
      siteId: site.id,
      name: '新闻',
      listUrl: 'https://example.com/news',
    })
    rule = await createRule(app, {
      siteId: site.id,
      name: '仅列表规则',
      config: sampleConfig({ collectScope: 'list' }),
    })
    const patched = await call(app, `/api/categories/${category.id}`, json({ ruleId: rule.id }, 'PATCH'))
    expect(patched.status).toBe(200)

    for (const n of [1, 2, 3]) {
      const outcome = saveListArticle({
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
        title: `待补采 ${n}`,
        url: `https://example.com/article/${n}`,
      })
      expect(outcome.status).toBe('created')
      pendingIds.push(outcome.articleId!)
    }

    // 已采集的文章：补采时要被排除
    saveCrawledArticle(
      {
        article: {
          siteId: String(site.id),
          categoryId: String(category.id),
          title: '已采完的文章',
          url: 'https://example.com/article/done',
          content: '正文足够长，详情阶段已完成。',
        } satisfies ArticleData,
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
  })

  afterAll(() => stopTestApp())

  it('规则里的 collectScope=list 成为任务默认值', async () => {
    const task = await createTask({ type: 'category' })
    expect(taskSnapshot(task.id).options.collectScope).toBe('list')
  })

  it('任务显式指定时覆盖规则默认值', async () => {
    const task = await createTask({ type: 'category', options: { collectScope: 'full' } })
    expect(taskSnapshot(task.id).options.collectScope).toBe('full')
  })

  it('urls / detail 任务不受规则默认值影响', async () => {
    const task = await createTask({ type: 'detail' })
    expect(taskSnapshot(task.id).options.collectScope).toBeUndefined()
  })

  it('单篇补采：按 id 创建 detail 任务', async () => {
    const response = await call(
      app,
      '/api/articles/collect-detail',
      json({ ids: [pendingIds[0]] }),
    )
    expect(response.status).toBe(200)
    const result = response.body.data
    expect(result.articleCount).toBe(1)
    expect(result.tasks).toHaveLength(1)

    const task = getModels().crawlTask.findById(result.tasks[0].taskId)
    expect(task?.type).toBe('detail')
    expect(JSON.parse(String(task?.configSnapshot)).options.articleIds).toEqual([pendingIds[0]])
  })

  it('批量补采：同一栏目的多篇合成一个任务', async () => {
    const response = await call(
      app,
      '/api/articles/collect-detail',
      json({ ids: pendingIds }),
    )
    expect(response.status).toBe(200)
    const result = response.body.data
    // 第一篇上一轮已补过，但状态仍是 pending（没有真的抓取），所以仍会提交
    expect(result.articleCount).toBe(pendingIds.length)
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].categoryId).toBe(category.id)
  })

  it('已采集的文章不会被补采', async () => {
    const done = getModels().article.findOne({ url: 'https://example.com/article/done' })
    const response = await call(app, '/api/articles/collect-detail', json({ ids: [done!.id] }))
    expect(response.status).toBe(200)
    expect(response.body.data.articleCount).toBe(0)
    expect(response.body.data.tasks).toHaveLength(0)
  })

  it('按筛选条件批量补采待采文章', async () => {
    const response = await call(
      app,
      '/api/articles/collect-detail',
      json({ siteId: site.id, categoryId: category.id, limit: 10 }),
    )
    expect(response.status).toBe(200)
    expect(response.body.data.articleCount).toBe(pendingIds.length)
  })

  it('ids 与 detail 类型不匹配时给出校验错误', async () => {
    const response = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, categoryIds: [category.id], type: 'category', options: { articleIds: [1] } }),
    )
    expect(response.status).toBe(400)
  })
})
