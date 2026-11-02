import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '@webcrawler/database'
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
import { getAppRuntime } from '../src/app-runtime.js'
import { startSiteFixture, type SiteFixture } from './helpers/site-fixture.js'

describe('定时任务', () => {
  let app: H3
  let site: any
  let category: any
  let rule: any
  let fixture: SiteFixture

  beforeAll(async () => {
    fixture = await startSiteFixture()
    app = startTestApp({ allowPrivateNetwork: true })
    site = await createSite(app, {
      name: '定时站点',
      domain: '127.0.0.1',
      baseUrl: fixture.origin,
    })
    category = await createCategory(app, {
      siteId: site.id,
      name: '新闻',
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
        clean: { removeSelectors: ['.ad'] },
      }),
    })
    await call(app, `/api/categories/${category.id}`, json({ ruleId: rule.id }, 'PATCH'))
  })

  afterAll(async () => {
    stopTestApp()
    await fixture.close()
  })

  it('创建每天 03:00 执行：生成 cron 与下次执行时间', async () => {
    const response = await call(
      app,
      '/api/schedules',
      json({
        name: '每日采集',
        siteId: site.id,
        categoryIds: [category.id],
        taskType: 'category',
        frequency: 'daily',
        hour: 3,
        minute: 0,
        timezone: 'Asia/Shanghai',
      }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe(`/api/schedules/${response.body.data.id}`)
    const schedule = response.body.data
    expect(schedule.cron).toBe('0 3 * * *')
    expect(schedule.timezone).toBe('Asia/Shanghai')
    expect(schedule.enabled).toBe(true)
    expect(schedule.nextRunAt).toBeTruthy()
    expect(new Date(schedule.nextRunAt).getUTCHours()).toBe(19) // 03:00 +08:00 = 19:00Z
  })

  it('参数校验：缺小时 / 非法 cron / 非法时区 / 不支持 urls 类型', async () => {
    const noHour = await call(
      app,
      '/api/schedules',
      json({ name: 'x', siteId: site.id, frequency: 'daily', timezone: 'Asia/Shanghai' }),
    )
    expect(noHour.status).toBe(400)
    expect(noHour.body.error.message).toContain('hour')

    const badCron = await call(
      app,
      '/api/schedules',
      json({ name: 'bad-cron', siteId: site.id, frequency: 'cron', cron: '99 99 * * *' }),
    )
    expect(badCron.status).toBe(400)

    const badZone = await call(
      app,
      '/api/schedules',
      json({ name: 'bad-zone', siteId: site.id, frequency: 'daily', hour: 1, timezone: 'Mars/Base' }),
    )
    expect(badZone.status).toBe(400)
    expect(badZone.body.error.message).toContain('时区')

    const urls = await call(
      app,
      '/api/schedules',
      json({ name: 'urls', siteId: site.id, frequency: 'hourly', taskType: 'urls' }),
    )
    expect(urls.status).toBe(400)
  })

  it('名称唯一，列表支持站点与启停筛选', async () => {
    const duplicate = await call(
      app,
      '/api/schedules',
      json({ name: '每日采集', siteId: site.id, frequency: 'hourly' }),
    )
    expect(duplicate.status).toBe(409)

    await call(
      app,
      '/api/schedules',
      json({ name: '停用的每小时', siteId: site.id, frequency: 'hourly', enabled: false }),
    )

    const all = await call(app, `/api/schedules?siteId=${site.id}`)
    expect(all.body.data.total).toBe(2)

    const disabled = await call(app, '/api/schedules?enabled=false')
    expect(disabled.body.data.total).toBe(1)
    expect(disabled.body.data.items[0].name).toBe('停用的每小时')
    expect(disabled.body.data.items[0].nextRunAt).toBeNull()
  })

  it('修改时间表会重新计算 cron 与下次执行时间', async () => {
    const created = await call(
      app,
      '/api/schedules',
      json({ name: '可修改', siteId: site.id, frequency: 'daily', hour: 1, timezone: 'UTC' }),
    )
    const id = created.body.data.id

    const patched = await call(app, `/api/schedules/${id}`, json({ hour: 5, minute: 30 }, 'PATCH'))
    expect(patched.status).toBe(200)
    expect(patched.body.data.cron).toBe('30 5 * * *')
    expect(new Date(patched.body.data.nextRunAt).getUTCHours()).toBe(5)
  })

  it('启用 / 禁用：禁用后清空下次执行时间并移除计时器', async () => {
    const created = await call(
      app,
      '/api/schedules',
      json({ name: '启停测试', siteId: site.id, frequency: 'hourly' }),
    )
    const id = created.body.data.id

    const scheduler = getAppRuntime().scheduler
    scheduler.start()
    expect(scheduler.jobCount).toBeGreaterThanOrEqual(1)

    const disabled = await call(app, `/api/schedules/${id}/status`, json({ enabled: false }, 'PATCH'))
    expect(disabled.body.data.enabled).toBe(false)
    expect(disabled.body.data.nextRunAt).toBeNull()

    const enabled = await call(app, `/api/schedules/${id}/status`, json({ enabled: true }, 'PATCH'))
    expect(enabled.body.data.enabled).toBe(true)
    expect(enabled.body.data.nextRunAt).toBeTruthy()
    scheduler.stop()
  })

  it('手动触发只创建任务，不同步执行采集；同一栏目已有活动任务时跳过', async () => {
    const created = await call(
      app,
      '/api/schedules',
      json({
        name: '手动触发',
        siteId: site.id,
        categoryIds: [category.id],
        taskType: 'category',
        frequency: 'daily',
        hour: 2,
        timezone: 'UTC',
      }),
    )
    const scheduleId = created.body.data.id

    const first = await call(app, `/api/schedules/${scheduleId}/run`, { method: 'POST' })
    expect(first.status).toBe(200)
    expect(first.body.data.skipped).toBe(false)
    expect(first.body.data.task.status).toBe('pending')
    expect(first.body.data.task.trigger).toBe('schedule')

    const second = await call(app, `/api/schedules/${scheduleId}/run`, { method: 'POST' })
    expect(second.body.data.skipped).toBe(true)

    await getTestRuntime().whenIdle(20_000)
    const detail = await call(app, `/api/tasks/${first.body.data.task.id}`)
    expect(detail.body.data.status).toBe('completed')
    expect(detail.body.data.scheduleId).toBe(scheduleId)

    const refreshed = await call(app, `/api/schedules/${scheduleId}`)
    expect(refreshed.body.data.lastTaskId).toBe(first.body.data.task.id)
    expect(refreshed.body.data.lastRunAt).toBeTruthy()
  })

  it('删除定时任务后计时器一并移除', async () => {
    const created = await call(
      app,
      '/api/schedules',
      json({ name: '待删除', siteId: site.id, frequency: 'hourly' }),
    )
    const id = created.body.data.id

    const scheduler = getAppRuntime().scheduler
    scheduler.start()
    const before = scheduler.jobCount

    const deleted = await call(app, `/api/schedules/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(scheduler.jobCount).toBe(before - 1)
    expect(getModels().crawlSchedule.findById(id)).toBeUndefined()
    scheduler.stop()
  })
})
