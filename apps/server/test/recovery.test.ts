import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '@webcrawler/database'
import { CrawlTaskStatus } from '@webcrawler/shared'
import {
  call,
  createCategory,
  createRule,
  createSite,
  getTestRuntime,
  json,
  sampleConfig,
  startTestApp,
  stopTestApp,
} from './helpers/app.js'
import { startSiteFixture, type SiteFixture } from './helpers/site-fixture.js'
import { createTask } from '../src/services/task-service.js'

/**
 * 服务重启恢复。
 *
 * 直接构造各种「重启残留」状态的行（running / pending / paused / completed），
 * 再调用 `runtime.recover()` 验证：
 * - running 一律落 failed（保留断点，不猜测副作用）；
 * - pending 校验快照与站点后重新排队，并按断点续跑；
 * - 快照缺失或站点已删除的置 failed；
 * - paused 保持原状；
 * - 已完成任务不会被无条件重跑。
 */
describe('服务重启恢复', () => {
  let app: H3
  let fixture: SiteFixture
  let site: any
  let category: any
  let rule: any

  beforeAll(async () => {
    fixture = await startSiteFixture()
    app = startTestApp({ allowPrivateNetwork: true, taskConcurrency: 2 })
    site = await createSite(app, {
      name: 'Fixture 新闻',
      domain: '127.0.0.1',
      baseUrl: fixture.origin,
    })
    category = await createCategory(app, {
      siteId: site.id,
      name: '新闻列表',
      listUrl: `${fixture.origin}/news`,
    })
    rule = await createRule(app, {
      siteId: site.id,
      name: '默认规则',
      config: sampleConfig({
        detail: {
          fields: {
            title: { type: 'text', selector: 'h1.article-title', required: true },
            content: { type: 'html', selector: '.article-content' },
          },
        },
      }),
    })
    const patched = await call(app, `/api/categories/${category.id}`, json({ ruleId: rule.id }, 'PATCH'))
    expect(patched.status).toBe(200)
  })

  afterAll(async () => {
    stopTestApp()
    await fixture.close()
  })

  /** 用服务层创建任务（不入队），模拟「进程崩溃前已落库」的任务。 */
  function seedTask(name: string, overrides: Record<string, unknown> = {}): number {
    const task = createTask({
      siteId: site.id,
      type: 'category',
      categoryIds: [category.id],
      name,
    })
    if (Object.keys(overrides).length > 0) {
      getModels().crawlTask.update(task.id, overrides)
    }
    return task.id
  }

  it('running 任务被标记 failed，并保留断点', () => {
    const checkpoint = {
      completedCategoryIds: [],
      page: 2,
      processedUrls: [`${fixture.origin}/article/1`],
      lastUrl: `${fixture.origin}/article/1`,
      updatedAt: new Date().toISOString(),
    }
    const taskId = seedTask('中断的任务', {
      status: CrawlTaskStatus.RUNNING,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      checkpoint: JSON.stringify(checkpoint),
    })

    const result = getTestRuntime().recover()
    expect(result.failed).toContain(taskId)

    const row = getModels().crawlTask.findById(taskId)!
    expect(row.status).toBe(CrawlTaskStatus.FAILED)
    expect(row.errorSummary).toContain('服务重启导致任务中断')
    expect(row.completedAt).toBeTruthy()
    // 断点保留，用户重试时可以按断点续跑
    expect(JSON.parse(row.checkpoint as string).processedUrls).toEqual(checkpoint.processedUrls)
    expect(JSON.parse(row.checkpoint as string).page).toBe(2)

    const logs = getModels().crawlLog.findMany({ taskId })
    expect(logs.some((log) => (log.message ?? '').includes('已标记为 failed'))).toBe(true)
  })

  it('pending 任务重新排队，并按断点跳过已处理的 URL', async () => {
    const taskId = seedTask('待执行的任务', {
      status: CrawlTaskStatus.PENDING,
      checkpoint: JSON.stringify({
        completedCategoryIds: [],
        page: 1,
        processedUrls: [`${fixture.origin}/article/1`],
        lastUrl: `${fixture.origin}/article/1`,
        updatedAt: new Date().toISOString(),
      }),
    })

    const result = getTestRuntime().recover()
    expect(result.requeued).toContain(taskId)

    await getTestRuntime().whenIdle(20_000)

    const task = await call(app, `/api/tasks/${taskId}`)
    expect(task.body.data.status).toBe('completed')
    expect(task.body.data.progress.skipped).toBe(1)
    expect(task.body.data.progress.success).toBe(4)
    expect(task.body.data.progress.total).toBe(5)

    const articles = await call(app, `/api/articles?taskId=${taskId}&pageSize=100`)
    expect(articles.body.data.total).toBe(4)
  })

  it('paused 任务保持暂停，不会被自动拉起', () => {
    const taskId = seedTask('暂停中的任务', { status: CrawlTaskStatus.PAUSED })

    const result = getTestRuntime().recover()
    expect(result.paused).toContain(taskId)
    expect(result.requeued).not.toContain(taskId)

    const row = getModels().crawlTask.findById(taskId)!
    expect(row.status).toBe(CrawlTaskStatus.PAUSED)
  })

  it('已完成任务不会被无条件重跑', async () => {
    const taskId = seedTask('已完成的任务', { status: CrawlTaskStatus.COMPLETED })
    const before = getModels().crawlTask.findById(taskId)!.attempts

    const result = getTestRuntime().recover()
    expect(result.requeued).not.toContain(taskId)
    expect(result.failed).not.toContain(taskId)
    expect(getTestRuntime().runningIds).not.toContain(taskId)

    await getTestRuntime().whenIdle(10_000)
    const row = getModels().crawlTask.findById(taskId)!
    expect(row.status).toBe(CrawlTaskStatus.COMPLETED)
    expect(row.attempts).toBe(before)
  })

  it('快照缺失的任务置 failed，不会反复重启重试', () => {
    const orphan = getModels().crawlTask.create({
      name: '没有快照的任务',
      siteId: site.id,
      categoryIds: JSON.stringify([category.id]),
      type: 'category',
      status: CrawlTaskStatus.PENDING,
      configSnapshot: null,
    })

    const result = getTestRuntime().recover()
    expect(result.failed).toContain(orphan.id)

    const row = getModels().crawlTask.findById(orphan.id)!
    expect(row.status).toBe(CrawlTaskStatus.FAILED)
    expect(row.errorSummary).toContain('缺少配置快照')

    // 再次恢复不会重复处理
    const second = getTestRuntime().recover()
    expect(second.failed).not.toContain(orphan.id)
  })

  it('站点已删除的任务置 failed 并说明原因', () => {
    // 用一份指向已不存在站点的快照模拟「任务落库后站点被删除」
    const temp = createTask({
      siteId: site.id,
      type: 'category',
      categoryIds: [category.id],
      name: '站点将被删除的任务',
    })
    const snapshot = JSON.parse(getModels().crawlTask.findById(temp.id)!.configSnapshot as string)
    getModels().crawlTask.update(temp.id, {
      status: CrawlTaskStatus.PENDING,
      configSnapshot: JSON.stringify({ ...snapshot, siteId: 999_999 }),
    })

    const result = getTestRuntime().recover()
    expect(result.failed).toContain(temp.id)

    const row = getModels().crawlTask.findById(temp.id)!
    expect(row.status).toBe(CrawlTaskStatus.FAILED)
    expect(row.errorSummary).toContain('站点已不存在')
  })

  it('恢复后运行时保持空闲，没有任务卡在 running', async () => {
    await getTestRuntime().whenIdle(20_000)
    expect(getTestRuntime().runningIds).toEqual([])
    expect(getTestRuntime().queuedCount).toBe(0)
    expect(getModels().crawlTask.count({ status: CrawlTaskStatus.RUNNING })).toBe(0)
  })
})
