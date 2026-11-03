import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { call, startTestApp, stopTestApp } from './helpers/app.js'
import { writeLog } from '../../src/server/services/log-service.js'

/**
 * 日志查询与脱敏。
 *
 * 任务书要求：不得把代理密码、Cookie、Authorization 写进日志。
 * 这里直接调用 `writeLog` 写入「最坏情况」的入参（URL 带 token、detail 带密码与
 * Authorization 头、message 带内联密码），再通过 `/api/logs` 读回来断言。
 */
describe('日志与脱敏', () => {
  let app: H3

  beforeAll(() => {
    app = startTestApp()
  })

  afterAll(() => {
    stopTestApp()
  })

  it('URL 脱敏：userinfo 与敏感查询参数都不落明文', async () => {
    writeLog({
      taskId: 901,
      siteId: 1,
      level: 'error',
      stage: 'request',
      url: 'https://alice:s3cret-pass@example.com/news?token=abc123&id=7',
      message: '请求失败：连接超时',
    })

    const response = await call(app, '/api/logs?taskId=901')
    expect(response.status).toBe(200)
    expect(response.body.data.total).toBe(1)

    const entry = response.body.data.items[0]
    expect(entry.url).toContain('token=***')
    expect(entry.url).toContain('id=7')
    expect(entry.url).not.toContain('abc123')
    expect(entry.url).not.toContain('s3cret-pass')
    expect(entry.url).not.toContain('alice')
  })

  it('detail 深度脱敏：密码、Authorization、apiKey 全部替换为 ***', async () => {
    writeLog({
      taskId: 902,
      level: 'error',
      stage: 'save',
      url: 'https://example.com/article/1',
      message: '保存失败',
      detail: {
        password: 'p@ssw0rd',
        headers: { authorization: 'Bearer tok_live_123', 'user-agent': 'WebCrawler' },
        nested: { apiKey: 'k-9527', cookie: 'session=abc' },
        reason: 'duplicate key',
      },
    })

    const response = await call(app, '/api/logs?taskId=902')
    const entry = response.body.data.items[0]
    expect(entry.detail.password).toBe('***')
    expect(entry.detail.headers.authorization).toBe('***')
    expect(entry.detail.headers['user-agent']).toBe('WebCrawler')
    expect(entry.detail.nested.apiKey).toBe('***')
    expect(entry.detail.nested.cookie).toBe('***')
    // 非敏感字段保留，便于排查
    expect(entry.detail.reason).toBe('duplicate key')

    const serialized = JSON.stringify(response.body)
    expect(serialized).not.toContain('p@ssw0rd')
    expect(serialized).not.toContain('tok_live_123')
    expect(serialized).not.toContain('k-9527')
  })

  it('message 脱敏：内联密码与 Bearer 凭据被抹掉', async () => {
    writeLog({
      taskId: 903,
      level: 'warn',
      stage: 'extract',
      message: '请求携带 Authorization: Bearer abc.def-123 且 password=plain123 被拒绝',
    })

    const response = await call(app, '/api/logs?taskId=903')
    const message: string = response.body.data.items[0].message
    expect(message).toContain('Bearer ***')
    expect(message).toContain('password=***')
    expect(message).not.toContain('abc.def-123')
    expect(message).not.toContain('plain123')
  })

  it('筛选：按任务、级别、阶段、关键词与时间范围过滤', async () => {
    writeLog({ taskId: 910, level: 'info', stage: 'task', message: '任务开始执行' })
    writeLog({ taskId: 910, level: 'warn', stage: 'parse', message: '标题选择器未命中' })
    writeLog({ taskId: 910, level: 'error', stage: 'parse', message: '正文解析失败' })
    writeLog({ taskId: 911, level: 'error', stage: 'parse', message: '另一个任务的解析失败' })

    const byLevel = await call(app, '/api/logs?taskId=910&level=error')
    expect(byLevel.body.data.total).toBe(1)
    expect(byLevel.body.data.items[0].message).toContain('正文解析失败')

    const byStage = await call(app, '/api/logs?taskId=910&stage=parse')
    expect(byStage.body.data.total).toBe(2)

    const byKeyword = await call(app, `/api/logs?taskId=910&keyword=${encodeURIComponent('选择器')}`)
    expect(byKeyword.body.data.total).toBe(1)

    const byTask = await call(app, '/api/logs?taskId=911')
    expect(byTask.body.data.total).toBe(1)

    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    const byRange = await call(
      app,
      `/api/logs?taskId=910&from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`,
    )
    expect(byRange.body.data.total).toBe(3)

    const emptyRange = await call(app, `/api/logs?taskId=910&from=${encodeURIComponent(future)}`)
    expect(emptyRange.body.data.total).toBe(0)
  })

  it('分页与参数校验：默认按时间倒序，pageSize 超限返回 400', async () => {
    const page1 = await call(app, '/api/logs?taskId=910&pageSize=2&page=1')
    expect(page1.body.data.items).toHaveLength(2)
    expect(page1.body.data.totalPages).toBe(2)
    // id 倒序：最后写入的「正文解析失败」在最前
    expect(page1.body.data.items[0].message).toBe('正文解析失败')

    const page2 = await call(app, '/api/logs?taskId=910&pageSize=2&page=2')
    expect(page2.body.data.items).toHaveLength(1)
    expect(page2.body.data.items[0].message).toBe('任务开始执行')

    const tooLarge = await call(app, '/api/logs?pageSize=1000')
    expect(tooLarge.status).toBe(400)
    expect(tooLarge.body.error.code).toBe('VALIDATION_ERROR')

    const badFrom = await call(app, '/api/logs?from=not-a-date')
    expect(badFrom.status).toBe(400)
  })
})
