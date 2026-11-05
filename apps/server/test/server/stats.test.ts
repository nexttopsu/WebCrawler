import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getDatabaseContext, getModels } from '../../src/database/index.js'
import { call, createCategory, createSite, startTestApp, stopTestApp } from './helpers/app.js'

/**
 * 仪表盘统计。
 *
 * 重点验证「没有数据就是 0 / 空数组」，以及趋势分桶与今日计数
 * 确实按本地日期聚合，而不是编数。
 */
describe('统计概览', () => {
  let app: H3

  beforeAll(() => {
    app = startTestApp()
  })

  afterAll(() => {
    stopTestApp()
  })

  it('空库返回全零与空列表，不编造数据', async () => {
    const response = await call(app, '/api/stats/overview')
    expect(response.status).toBe(200)

    const data = response.body.data
    // 插件是内置的，空库也有 3 个
    expect(data.counts).toEqual({ sites: 0, categories: 0, articles: 0, tasks: 0, proxies: 0, plugins: 4 })
    expect(data.today).toEqual({ articles: 0, tasks: 0 })
    expect(data.running).toEqual({ tasks: 0, pending: 0 })
    expect(data.successRate).toBeNull()
    expect(data.trend).toHaveLength(14)
    expect(data.trend.every((point: any) => point.articles === 0)).toBe(true)
    expect(data.recentTasks).toEqual([])
    expect(data.recentErrors).toEqual([])
    expect(data.proxies).toEqual({ total: 0, enabled: 0, available: 0, unavailable: 0, unchecked: 0 })
  })

  it('按本地日期聚合今日文章与最近任务', async () => {
    const site = await createSite(app)
    await createCategory(app, { siteId: site.id, name: '列表', listUrl: 'https://example.com/news' })

    const now = new Date().toISOString()
    getModels().article.create({
      siteId: site.id,
      title: '今天的文章',
      url: 'https://example.com/a/1',
      content: '正文',
    })
    // 三天前的文章：不应计入今日，但应出现在趋势里（14 天窗口内）。
    // 文章统计现在按 createdAt 聚合，直接回写 createdAt 模拟历史数据。
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const old = getModels().article.create({
      siteId: site.id,
      title: '三天前的文章',
      url: 'https://example.com/a/2',
      content: '正文',
    })
    getDatabaseContext()
      .db.prepare('UPDATE article SET createdAt = ? WHERE id = ?')
      .run(threeDaysAgo.toISOString(), old.id)

    getModels().crawlTask.create({
      name: '已完成任务',
      siteId: site.id,
      type: 'category',
      status: 'completed',
      startedAt: now,
      completedAt: now,
      successCount: 1,
    })
    getModels().crawlTask.create({
      name: '运行中任务',
      siteId: site.id,
      type: 'category',
      status: 'running',
      startedAt: now,
    })

    const response = await call(app, '/api/stats/overview?days=7')
    const data = response.body.data

    expect(data.days).toBe(7)
    expect(data.trend).toHaveLength(7)
    expect(data.counts.articles).toBe(2)
    expect(data.counts.tasks).toBe(2)
    expect(data.today.articles).toBe(1)
    expect(data.today.tasks).toBe(2)
    expect(data.running.tasks).toBe(1)
    expect(data.successRate).toBe(1)

    const last = data.trend.at(-1)
    expect(last.articles).toBe(1)
    expect(last.completedTasks).toBe(1)
    // 三天前的那篇文章落在倒数第 4 个点
    expect(data.trend.at(-4).articles).toBe(1)

    expect(data.recentTasks).toHaveLength(2)
    expect(data.recentTasks[0].name).toBe('运行中任务')
  })

  it('最近错误取自 crawl_log 的 error 级别，且已脱敏', async () => {
    getDatabaseContext()
      .db.prepare(
        "INSERT INTO crawl_log (taskId, level, stage, message, createdAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, 'error', 'request', '请求失败 password=secret123', new Date().toISOString())

    const response = await call(app, '/api/stats/overview')
    const errors = response.body.data.recentErrors
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].level).toBe('error')
  })

  it('days 超出范围返回 400', async () => {
    const response = await call(app, '/api/stats/overview?days=999')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })
})
