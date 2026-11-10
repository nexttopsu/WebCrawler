/**
 * 插件管理 API。
 *
 * 插件全部内置：列表来自 `src/plugins/index.ts` 自动扫描的清单，数据库只存开关。
 * 这里验证「列表 / 详情 / 启停 / 重启后保持」，以及「扫描与重建接口已经不存在」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { createLogger } from '../../src/server/lib/logger.js'
import { call, json, startTestApp, stopTestApp } from './helpers/app.js'

describe('插件管理', () => {
  let app: H3

  beforeAll(() => {
    app = startTestApp()
  })

  afterAll(() => {
    stopTestApp()
  })

  it('列表直接来自内置清单，不依赖数据库里的副本', async () => {
    const { status, body } = await call(app, '/api/plugins')

    expect(status).toBe(200)
    expect(body.data.total).toBe(5)
    expect(body.data.items.map((item: { pluginId: string }) => item.pluginId)).toEqual([
      'cntc-eyxw-news',
      'demo-fixture',
      'example-flow-news',
      'example-parser-clean',
      'generic-cover-download',
    ])

    const demo = body.data.items.find((item: { pluginId: string }) => item.pluginId === 'demo-fixture')
    expect(demo).toMatchObject({
      name: '演示 · 本地 Fixture',
      type: 'flow',
      slots: ['list', 'detail'],
      source: 'src/plugins/demo-fixture.ts',
      enabled: true,
      registered: true,
      status: 'enabled',
      error: null,
    })
  })

  it('类型与关键字筛选在内存里完成', async () => {
    const parser = await call(app, '/api/plugins?type=parser')
    expect(parser.body.data.items.map((item: { pluginId: string }) => item.pluginId)).toEqual([
      'example-parser-clean',
      'generic-cover-download',
    ])

    const keyword = await call(app, '/api/plugins?keyword=fixture')
    expect(keyword.body.data.items).toHaveLength(1)
    expect(keyword.body.data.items[0].pluginId).toBe('demo-fixture')
  })

  it('详情返回源码位置与支持位置', async () => {
    const { status, body } = await call(app, '/api/plugins/example-flow-news')

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      pluginId: 'example-flow-news',
      type: 'flow',
      slots: ['list', 'detail'],
      source: 'src/plugins/examples/example-flow-news.ts',
      registered: true,
    })
  })

  it('不存在的插件返回 404', async () => {
    const { status, body } = await call(app, '/api/plugins/not-exist')
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('停用后从注册表移除，启用后立即恢复', async () => {
    const off = await call(app, '/api/plugins/demo-fixture/status', json({ enabled: false }, 'PATCH'))
    expect(off.status).toBe(200)
    expect(off.body.data).toMatchObject({ enabled: false, registered: false, status: 'disabled' })

    // 停用的插件不再出现在系统信息里（那里读的是注册表）
    const info = await call(app, '/api/system/info')
    expect(info.body.data.plugins.items.map((item: { id: string }) => item.id)).not.toContain('demo-fixture')

    const on = await call(app, '/api/plugins/demo-fixture/status', json({ enabled: true }, 'PATCH'))
    expect(on.body.data).toMatchObject({ enabled: true, registered: true, status: 'enabled' })
  })

  it('停用状态落库，进程重启后仍然停用', async () => {
    await call(app, '/api/plugins/example-flow-news/status', json({ enabled: false }, 'PATCH'))

    // 新建一个 App 等同于重启进程：注册表是空的，只能靠启动时读数据库
    const restarted = createApp({
      config: { ...loadConfig({}), logLevel: 'error', proxySecretKey: 'test-secret-key-0123456789', debugDatabaseFile: ':memory:' },
      logger: createLogger('error'),
    })
    const response = await call(restarted, '/api/plugins')
    const row = response.body.data.items.find(
      (item: { pluginId: string }) => item.pluginId === 'example-flow-news',
    )

    expect(row).toMatchObject({ enabled: false, registered: false, status: 'disabled' })
    // 其它插件不受影响
    const demo = response.body.data.items.find((item: { pluginId: string }) => item.pluginId === 'demo-fixture')
    expect(demo.registered).toBe(true)
  })

  it('扫描与重建注册表接口已经不存在', async () => {
    // 路径已经不再对应任何 POST 处理：可能落到 404，也可能因为同名 GET 路由而 405
    const scan = await call(app, '/api/plugins/scan', json({}))
    expect([404, 405]).toContain(scan.status)

    const refresh = await call(app, '/api/plugins/refresh', json({}))
    expect([404, 405]).toContain(refresh.status)
  })

  it('错误日志按插件 id 查询', async () => {
    const { status, body } = await call(app, '/api/plugins/demo-fixture/errors?limit=10')
    expect(status).toBe(200)
    expect(Array.isArray(body.data.items)).toBe(true)
  })
})
