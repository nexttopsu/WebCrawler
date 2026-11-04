import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '../../src/database/index.js'
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

/**
 * 任务创建与后台执行。
 *
 * 覆盖：快照构建、关联校验、真实抓取落库、增量去重、暂停 / 恢复 / 取消、
 * 重试与非法状态转换、任务日志。
 */
describe('采集任务', () => {
  let app: H3
  let fixture: SiteFixture
  let site: any
  let category: any
  let rule: any

  function taskConfig() {
    return sampleConfig({
      request: { mode: 'http', method: 'GET', timeoutMs: 5000 },
      detail: {
        fields: {
          title: { type: 'text', selector: 'h1.article-title', required: true },
          content: { type: 'html', selector: '.article-content' },
          author: { type: 'text', selector: '.author' },
          publishTime: { type: 'text', selector: '.publish-time' },
        },
      },
      clean: { removeSelectors: ['.ad'] },
    })
  }

  beforeAll(async () => {
    fixture = await startSiteFixture()
    app = startTestApp({ allowPrivateNetwork: true })
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
      config: taskConfig(),
    })
    const patched = await call(app, `/api/categories/${category.id}`, json({ ruleId: rule.id }, 'PATCH'))
    expect(patched.status).toBe(200)
  })

  afterAll(async () => {
    stopTestApp()
    await fixture.close()
  })

  it('创建任务：立即返回 pending 与配置快照', async () => {
    const response = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, type: 'category', categoryIds: [category.id] }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe(`/api/tasks/${response.body.data.id}`)
    const task = response.body.data
    expect(task.status).toBe('pending')
    expect(task.trigger).toBe('manual')
    expect(task.categoryIds).toEqual([category.id])
    expect(task.name).toContain('Fixture 新闻')

    const detail = await call(app, `/api/tasks/${task.id}`)
    expect(detail.body.data.configSnapshot.siteId).toBe(site.id)
    expect(detail.body.data.configSnapshot.categories[0].ruleId).toBe(rule.id)
    expect(detail.body.data.configSnapshot.categories[0].config.list.itemSelector).toBe('.news-item')

    // 本用例只验证创建与快照，取消掉这次执行，避免影响后续「首次抓取」的断言
    const cancelled = await call(app, `/api/tasks/${task.id}/cancel`, { method: 'POST' })
    expect([200, 409]).toContain(cancelled.status)
    await getTestRuntime().whenIdle(20_000)
    expect(getModels().article.count()).toBe(0)
  })

  it('创建任务：类型与参数不匹配返回 400，站点停用返回 409', async () => {
    const missingCategories = await call(app, '/api/tasks', json({ siteId: site.id, type: 'category' }))
    expect(missingCategories.status).toBe(400)
    expect(missingCategories.body.error.code).toBe('VALIDATION_ERROR')

    const badUrls = await call(app, '/api/tasks', json({ siteId: site.id, type: 'urls' }))
    expect(badUrls.status).toBe(400)

    const inactive = await createSite(app, {
      name: '停用站点',
      domain: 'inactive.example.com',
      status: 'inactive',
    })
    const blocked = await call(app, '/api/tasks', json({ siteId: inactive.id, type: 'site' }))
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toContain('停用')
  })

  it('执行任务：抓取 5 篇文章并写入数据库', async () => {
    const created = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, type: 'category', categoryIds: [category.id], name: '首轮采集' }),
    )
    const taskId = created.body.data.id

    await getTestRuntime().whenIdle(20_000)

    const detail = await call(app, `/api/tasks/${taskId}`)
    const task = detail.body.data
    expect(task.status).toBe('completed')
    expect(task.progress.total).toBe(5)
    expect(task.progress.success).toBe(5)
    expect(task.progress.failed).toBe(0)
    expect(task.progress.percent).toBe(100)
    expect(task.startedAt).toBeTruthy()
    expect(task.completedAt).toBeTruthy()

    const articles = await call(app, `/api/articles?taskId=${taskId}&pageSize=100`)
    expect(articles.body.data.total).toBe(5)
    const titles = articles.body.data.items.map((item: any) => item.title).sort()
    expect(titles[0]).toContain('第一篇报道')

    const first = articles.body.data.items.find((item: any) => item.url.endsWith('/article/1'))
    const detailArticle = await call(app, `/api/articles/${first.id}`)
    expect(detailArticle.body.data.content).toContain('城市更新项目')
    expect(detailArticle.body.data.content).not.toContain('广告位')
    expect(detailArticle.body.data.articleTime).toMatch(/^2026-01-01T/)
    // 规则未映射封面时允许为空，不再回退正文首图
    expect(detailArticle.body.data.coverUrl).toBeNull()

    const raw = await call(app, `/api/articles/${first.id}/raw`)
    expect(raw.body.data.html).toContain('article-title')
  })

  it('增量任务：已采集的 URL 全部跳过，文章数不变', async () => {
    const before = getModels().article.count()
    const created = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, type: 'incremental', categoryIds: [category.id], name: '增量采集' }),
    )
    await getTestRuntime().whenIdle(20_000)

    const task = await call(app, `/api/tasks/${created.body.data.id}`)
    expect(task.body.data.status).toBe('completed')
    expect(task.body.data.progress.skipped).toBe(5)
    expect(task.body.data.progress.success).toBe(0)
    expect(getModels().article.count()).toBe(before)
  })

  it('暂停后恢复：从断点继续，不重复写入', async () => {
    const created = await call(
      app,
      '/api/tasks',
      json({
        siteId: site.id,
        type: 'full',
        categoryIds: [category.id],
        name: '暂停测试',
        options: { rateLimitMs: 250 },
      }),
    )
    const taskId = created.body.data.id

    // 立即暂停：此时最多处理了一两篇
    const paused = await call(app, `/api/tasks/${taskId}/pause`, { method: 'POST' })
    expect([200, 409]).toContain(paused.status)

    await new Promise((resolve) => setTimeout(resolve, 400))
    const afterPause = await call(app, `/api/tasks/${taskId}`)
    if (paused.status === 200) {
      expect(['paused', 'completed']).toContain(afterPause.body.data.status)
      if (afterPause.body.data.status === 'paused') {
        expect(afterPause.body.data.progress.success).toBeLessThan(5)
        const resumed = await call(app, `/api/tasks/${taskId}/resume`, { method: 'POST' })
        expect(resumed.status).toBe(200)
        expect(resumed.body.data.status).toBe('pending')
      }
    }

    await getTestRuntime().whenIdle(20_000)
    const finished = await call(app, `/api/tasks/${taskId}`)
    expect(finished.body.data.status).toBe('completed')
    expect(getModels().article.count()).toBeGreaterThanOrEqual(5)
  })

  it('取消任务：状态保持 cancelled，不会被执行器覆盖为 completed', async () => {
    const created = await call(
      app,
      '/api/tasks',
      json({
        siteId: site.id,
        type: 'full',
        categoryIds: [category.id],
        name: '取消测试',
        options: { rateLimitMs: 250 },
      }),
    )
    const taskId = created.body.data.id

    const cancelled = await call(app, `/api/tasks/${taskId}/cancel`, { method: 'POST' })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data.status).toBe('cancelled')

    await getTestRuntime().whenIdle(20_000)
    const after = await call(app, `/api/tasks/${taskId}`)
    expect(after.body.data.status).toBe('cancelled')
    expect(after.body.data.errorSummary).toContain('取消')
  })

  it('非法状态转换被拒绝：已完成任务不能暂停，也不能重复完成', async () => {
    const completed = getModels().crawlTask.findMany({ status: 'completed' })[0]!
    const response = await call(app, `/api/tasks/${completed.id}/pause`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.message).toContain('暂停')
    expect(response.body.error.message).toContain('completed')

    const retried = await call(app, `/api/tasks/${completed.id}/retry`, { method: 'POST' })
    expect(retried.status).toBe(409)
  })

  it('失败任务可以重试，尝试次数递增', async () => {
    const broken = await createCategory(app, {
      siteId: site.id,
      name: '坏地址栏目',
      listUrl: `${fixture.origin}/nope`,
    })
    await call(app, `/api/categories/${broken.id}`, json({ ruleId: rule.id }, 'PATCH'))

    const created = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, type: 'category', categoryIds: [broken.id], name: '失败任务' }),
    )
    await getTestRuntime().whenIdle(20_000)

    const failed = await call(app, `/api/tasks/${created.body.data.id}`)
    expect(failed.body.data.status).toBe('failed')
    expect(failed.body.data.errorSummary).toContain('列表抓取失败')

    const retried = await call(app, `/api/tasks/${created.body.data.id}/retry`, { method: 'POST' })
    expect(retried.status).toBe(200)
    expect(retried.body.data.status).toBe('pending')
    expect(retried.body.data.attempts).toBe(1)

    await getTestRuntime().whenIdle(20_000)
    const again = await call(app, `/api/tasks/${created.body.data.id}`)
    expect(again.body.data.status).toBe('failed')
    expect(again.body.data.attempts).toBe(2)
  })

  it('任务日志：包含创建、执行与完成记录，且不含敏感信息', async () => {
    const task = getModels().crawlTask.findMany({ status: 'completed' })[0]!
    const logs = await call(app, `/api/logs?taskId=${task.id}&pageSize=100`)
    expect(logs.status).toBe(200)
    expect(logs.body.data.total).toBeGreaterThan(0)
    const messages = logs.body.data.items.map((item: any) => item.message).join('\n')
    expect(messages).toContain('任务已创建')
    expect(messages).toContain('任务开始执行')
    expect(messages).toContain('任务完成')
    expect(messages).not.toContain('password')
  })

  it('排队中的任务可以删除，运行中的任务不能删除', async () => {
    const running = getModels().crawlTask.create({
      name: '伪运行任务',
      siteId: site.id,
      categoryIds: JSON.stringify([category.id]),
      type: 'category',
      status: 'running',
    })
    const blocked = await call(app, `/api/tasks/${running.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)

    const done = getModels().crawlTask.findMany({ status: 'completed' })[0]!
    const deleted = await call(app, `/api/tasks/${done.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.data.deleted).toBe(true)
  })
})
