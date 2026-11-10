/**
 * 捕获浏览器（调试数据 →「启动浏览器」）验收测试。
 *
 * 真实启动 Chromium 的成本与不确定性都不适合放进单元测试，这里覆盖
 * 能稳定验证的三层：
 * 1. 状态接口在未启动时是 idle，停止幂等；
 * 2. 启动参数校验（非法协议直接 400，不会真的拉起浏览器）；
 * 3. 捕获写入的语义：同一网址覆盖 raw，但保留备注 / 启停 / 命中统计。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { call, json, startTestApp, stopTestApp } from './helpers/app.js'
import {
  getDebugSample,
  lookupDebugRaw,
  saveCapturedSample,
  updateDebugSample,
} from '../../src/server/services/debug-data-service.js'
import { isCapturableStatus } from '../../src/server/services/debug-capture-service.js'

let app: H3

beforeAll(() => {
  app = startTestApp()
})

afterAll(() => {
  stopTestApp()
})

describe('捕获浏览器状态接口', () => {
  it('未启动时返回 idle 且统计全为 0', async () => {
    const response = await call(app, '/api/debug-data/capture/status')
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      state: 'idle',
      startedAt: null,
      captured: 0,
      created: 0,
      updated: 0,
      recent: [],
    })
  })

  it('没有会话时停止是幂等的，不报错', async () => {
    const response = await call(app, '/api/debug-data/capture/stop', json({}))
    expect(response.status).toBe(200)
    expect(response.body.data.state).toBe('idle')
  })

  it('起始网址不是 http(s) 时返回 400，且不会拉起浏览器', async () => {
    const response = await call(
      app,
      '/api/debug-data/capture/start',
      json({ startUrl: 'file:///etc/passwd' }),
    )
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')

    const status = await call(app, '/api/debug-data/capture/status')
    expect(status.body.data.state).toBe('idle')
  })

  it('未知字段被拒绝（strict schema）', async () => {
    const response = await call(
      app,
      '/api/debug-data/capture/start',
      json({ startUrl: 'https://example.com', viewport: 1 }),
    )
    expect(response.status).toBe(400)
  })
})

describe('只记录 200 / 304', () => {
  it('正常返回与缓存命中入库', () => {
    expect(isCapturableStatus(200)).toBe(true)
    expect(isCapturableStatus(304)).toBe(true)
  })

  it('跳转、错误页、分片响应都不入库', () => {
    for (const status of [201, 204, 206, 301, 302, 307, 400, 403, 404, 500, 502]) {
      expect(isCapturableStatus(status)).toBe(false)
    }
  })
})

describe('捕获写入调试库', () => {
  const url = 'https://capture.local/article/1.html'

  it('新建后同一网址再捕获：覆盖 raw，保留备注 / 启停 / 命中', () => {
    const first = saveCapturedSample({
      url,
      raw: '<html><body>第一版</body></html>',
      statusCode: 200,
      contentType: 'html',
      note: '浏览器捕获',
    })
    expect(first.created).toBe(true)
    expect(first.rawSize).toBe(Buffer.byteLength('<html><body>第一版</body></html>', 'utf8'))

    // 用户改了备注，并命中过一次
    updateDebugSample(first.id, { note: '我的备注' })
    expect(lookupDebugRaw(url)?.raw).toContain('第一版')

    const second = saveCapturedSample({
      url,
      raw: '<html><body>第二版</body></html>',
      statusCode: 201,
      contentType: 'html',
      note: '浏览器捕获',
    })
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)

    const detail = getDebugSample(first.id)
    expect(detail.raw).toContain('第二版')
    expect(detail.statusCode).toBe(201)
    // 备注不被自动捕获覆盖，命中次数继续累加
    expect(detail.note).toBe('我的备注')
    expect(detail.hitCount).toBe(1)
  })

  it('JSON 类型按 json 存档，编辑器可见', () => {
    const saved = saveCapturedSample({
      url: 'https://capture.local/api/list.json',
      raw: '{"items":[1,2,3]}',
      statusCode: 200,
      contentType: 'json',
      note: '浏览器捕获',
    })
    expect(saved.created).toBe(true)
    expect(getDebugSample(saved.id).contentType).toBe('json')
  })
})
