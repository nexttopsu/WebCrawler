import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/lib/logger.js'
import { call, json, startTestApp, stopTestApp } from './helpers/app.js'

/**
 * 插件管理。
 *
 * 不联网、不安装：只验证「本地目录扫描 → 清单校验 → 登记 → 启停 → 错误可见」，
 * 并且非法清单不能让请求失败，更不能让服务起不来。
 */
describe('插件管理', () => {
  let app: H3
  let root: string

  function writePlugin(dir: string, manifest: Record<string, unknown>): void {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  beforeAll(() => {
    app = startTestApp()
    root = mkdtempSync(join(tmpdir(), 'wc-plugins-'))
  })

  afterAll(() => {
    stopTestApp()
    rmSync(root, { recursive: true, force: true })
  })

  it('空库时插件列表为空', async () => {
    const response = await call(app, '/api/plugins')
    expect(response.status).toBe(200)
    expect(response.body.data.total).toBe(0)
    expect(response.body.data.items).toEqual([])
  })

  it('扫描目录：合法清单被登记并注册到运行时', async () => {
    writePlugin('demo-site', {
      name: 'demo-site',
      version: '1.2.0',
      type: 'source',
      description: '示例站点插件',
      coreVersion: '^0.6.0',
      config: { apiKey: 'should-be-masked' },
    })

    const scan = await call(app, '/api/plugins/scan', json({ directory: root }))
    expect(scan.status).toBe(200)
    expect(scan.body.data.exists).toBe(true)
    expect(scan.body.data.found).toBe(1)
    expect(scan.body.data.added).toBe(1)
    expect(scan.body.data.failed).toEqual([])

    const list = await call(app, '/api/plugins')
    expect(list.body.data.total).toBe(1)
    const plugin = list.body.data.items[0]
    expect(plugin).toMatchObject({ name: 'demo-site', version: '1.2.0', status: 'enabled', enabled: true })
    expect(plugin.registered).toBe(true)
    // 配置里的敏感键在返回前已脱敏
    expect(plugin.config.apiKey).toBe('***')

    expect(plugin.coreVersion).toBe('^0.6.0')

    // 重复扫描只更新，不重复新增
    const again = await call(app, '/api/plugins/scan', json({ directory: root }))
    expect(again.body.data.added).toBe(0)
    expect(again.body.data.updated).toBe(1)
  })

  it('非法清单与不兼容核心版本逐条报错，其余插件照常登记', async () => {
    writePlugin('broken-json', { name: 'broken', version: '1.0.0' })
    // 覆盖成非法 JSON
    writeFileSync(join(root, 'broken-json', 'plugin.json'), '{ not-json', 'utf8')
    writePlugin('future-plugin', {
      name: 'future-plugin',
      version: '1.0.0',
      type: 'parser',
      coreVersion: '^9.0.0',
    })
    writePlugin('good-plugin', { name: 'good-plugin', version: '0.2.1', type: 'hook' })

    const scan = await call(app, '/api/plugins/scan', json({ directory: root }))
    expect(scan.status).toBe(200)
    expect(scan.body.data.found).toBe(4)
    expect(scan.body.data.added).toBe(1)

    const failures = scan.body.data.failed as Array<{ name: string; error: string }>
    expect(failures.some((item) => item.name === 'broken-json' && item.error.includes('JSON'))).toBe(true)
    expect(
      failures.some((item) => item.name === 'future-plugin' && item.error.includes('核心版本')),
    ).toBe(true)

    const list = await call(app, '/api/plugins')
    expect(list.body.data.items.map((item: any) => item.name)).toEqual(
      expect.arrayContaining(['demo-site', 'good-plugin']),
    )
    expect(list.body.data.items.some((item: any) => item.name === 'future-plugin')).toBe(false)
  })

  it('扫描目录不存在时返回 exists=false，不报错', async () => {
    const response = await call(app, '/api/plugins/scan', json({ directory: join(root, 'not-exists') }))
    expect(response.status).toBe(200)
    expect(response.body.data.exists).toBe(false)
    expect(response.body.data.found).toBe(0)
  })

  it('启用 / 禁用会同步运行时注册表，刷新后不会复活', async () => {
    const disabled = await call(app, '/api/plugins/demo-site/status', json({ enabled: false }, 'PATCH'))
    expect(disabled.status).toBe(200)
    expect(disabled.body.data.status).toBe('disabled')
    expect(disabled.body.data.registered).toBe(false)

    const refreshed = await call(app, '/api/plugins/refresh', { method: 'POST' })
    expect(refreshed.status).toBe(200)

    const afterRefresh = await call(app, '/api/plugins/demo-site')
    expect(afterRefresh.body.data.registered).toBe(false)

    const enabled = await call(app, '/api/plugins/demo-site/status', json({ enabled: true }, 'PATCH'))
    expect(enabled.body.data.status).toBe('enabled')
    expect(enabled.body.data.registered).toBe(true)
  })

  it('插件错误日志可按名称查询，且不含敏感信息', async () => {
    const response = await call(app, '/api/plugins/future-plugin/errors')
    expect(response.status).toBe(200)
    expect(response.body.data.items.length).toBeGreaterThan(0)
    expect(response.body.data.items[0].message).toContain('future-plugin')
    expect(JSON.stringify(response.body)).not.toContain('should-be-masked')
  })

  it('重启后按数据库启用状态重建注册表，不会被误判成加载失败', async () => {
    // 新建一个 App 等同于进程重启：注册表是空的，只能靠启动时从数据库重建。
    const restarted = createApp({
      config: { ...loadConfig({}), logLevel: 'error', proxySecretKey: 'test-secret-key-0123456789' },
      logger: createLogger('error'),
    })

    const response = await call(restarted, '/api/plugins')
    const plugin = response.body.data.items.find((item: { name: string }) => item.name === 'demo-site')
    expect(plugin).toBeTruthy()
    expect(plugin.registered).toBe(true)
    expect(plugin.status).toBe('enabled')
  })

  it('未知插件返回 404，非法名称返回 400', async () => {
    const missing = await call(app, '/api/plugins/not-installed')
    expect(missing.status).toBe(404)

    const invalid = await call(app, '/api/plugins/bad%20name')
    expect(invalid.status).toBe(400)
  })
})
