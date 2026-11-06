import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getDatabaseContext } from '../../src/database/index.js'
import { call, getTestRuntime, json, startTestApp, stopTestApp } from './helpers/app.js'

/**
 * 系统设置。
 *
 * 要求：白名单校验、范围校验、脱敏（默认代理只给 id），
 * 并且「立即生效」的项要真的作用到运行时，而不是只写进数据库。
 */
describe('系统设置', () => {
  let app: H3

  beforeAll(() => {
    app = startTestApp()
  })

  afterAll(() => {
    stopTestApp()
  })

  it('读取设置：包含白名单项与只读运行信息', async () => {
    const response = await call(app, '/api/settings')
    expect(response.status).toBe(200)

    const { items, readonly } = response.body.data
    const keys = items.map((item: any) => item.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'request.timeoutMs',
        'task.concurrency',
        'task.siteConcurrency',
        'task.rateLimitMs',
        'task.retries',
        'task.maxDurationMs',
        'browser.headless',
        'log.level',
        'log.retentionDays',
        'system.timezone',
        'system.defaultProxyId',
      ]),
    )

    expect(readonly.version).toBe('0.7.0')
    expect(readonly.databaseFile).toContain('memory')
    expect(readonly.schemaVersion).toBe(8)
    expect(typeof readonly.activeTimeZone).toBe('string')

    const concurrency = items.find((item: any) => item.key === 'task.concurrency')
    expect(concurrency.effect).toBe('immediate')
    expect(concurrency.control).toBe('number')
    expect(concurrency.value).toBe(2)
  })

  it('修改并发与限速后立即作用到运行时', async () => {
    const response = await call(
      app,
      '/api/settings',
      json({ 'task.concurrency': 4, 'task.siteConcurrency': 2, 'task.rateLimitMs': 50 }, 'PATCH'),
    )
    expect(response.status).toBe(200)
    expect(response.body.data.applied).toEqual(
      expect.arrayContaining(['task.concurrency', 'task.siteConcurrency', 'task.rateLimitMs']),
    )

    const runtime = getTestRuntime()
    expect(runtime.limits).toEqual({ total: 4, perKey: 2 })

    const reread = await call(app, '/api/settings')
    const value = reread.body.data.items.find((item: any) => item.key === 'task.concurrency')
    expect(value.value).toBe(4)
  })

  it('未知键、越界值与非法时区返回 400', async () => {
    const unknown = await call(app, '/api/settings', json({ 'task.unknown': 1 }, 'PATCH'))
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.message).toContain('白名单')

    const outOfRange = await call(app, '/api/settings', json({ 'task.concurrency': 999 }, 'PATCH'))
    expect(outOfRange.status).toBe(400)

    const badTimeZone = await call(app, '/api/settings', json({ 'system.timezone': 'Mars/Base' }, 'PATCH'))
    expect(badTimeZone.status).toBe(400)
    expect(badTimeZone.body.error.message).toContain('时区')

    const empty = await call(app, '/api/settings', json({}, 'PATCH'))
    expect(empty.status).toBe(400)
  })

  it('默认代理只接受存在的代理，且不返回密码', async () => {
    const missing = await call(app, '/api/settings', json({ 'system.defaultProxyId': 999 }, 'PATCH'))
    expect(missing.status).toBe(400)
    expect(missing.body.error.message).toContain('不存在')

    const created = await call(
      app,
      '/api/proxies',
      json({ name: '默认代理', type: 'http', host: '127.0.0.1', port: 8080, username: 'u', password: 'p@ss' }),
    )
    expect(created.status).toBe(201)

    const updated = await call(
      app,
      '/api/settings',
      json({ 'system.defaultProxyId': created.body.data.id }, 'PATCH'),
    )
    expect(updated.status).toBe(200)
    const item = updated.body.data.items.find((entry: any) => entry.key === 'system.defaultProxyId')
    expect(item.value).toBe(created.body.data.id)
    expect(JSON.stringify(updated.body)).not.toContain('p@ss')
  })

  it('日志保留天数：保存时清理过期日志', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const fresh = new Date().toISOString()
    const db = getDatabaseContext().db
    db.prepare('INSERT INTO crawl_log (level, stage, message, createdAt) VALUES (?,?,?,?)').run(
      'info',
      'task',
      '十天前的日志',
      old,
    )
    db.prepare('INSERT INTO crawl_log (level, stage, message, createdAt) VALUES (?,?,?,?)').run(
      'info',
      'task',
      '今天的日志',
      fresh,
    )

    const response = await call(app, '/api/settings', json({ 'log.retentionDays': 3 }, 'PATCH'))
    expect(response.status).toBe(200)

    const rows = db.prepare("SELECT message FROM crawl_log WHERE message LIKE '%的日志'").all() as Array<{
      message: string
    }>
    expect(rows.map((row) => row.message)).toEqual(['今天的日志'])
  })

  it('保存的设置重启后仍然生效（读取自数据库而非默认值）', async () => {
    const logs = await call(app, '/api/settings')
    const level = logs.body.data.items.find((item: any) => item.key === 'log.level')
    // 测试环境的 logger 以 error 级别创建，因此默认值就是 error
    expect(level.value).toBe('error')

    const saved = await call(app, '/api/settings', json({ 'log.level': 'warn' }, 'PATCH'))
    expect(saved.status).toBe(200)
    expect(saved.body.data.applied).toContain('log.level')

    const again = await call(app, '/api/settings')
    expect(again.body.data.items.find((item: any) => item.key === 'log.level').value).toBe('warn')
  })
})
