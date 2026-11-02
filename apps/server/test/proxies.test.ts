import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '@webcrawler/database'
import { call, createCategory, createSite, json, startTestApp, stopTestApp } from './helpers/app.js'
import { flushProxyStats, pendingProxyStats, recordProxyUsage } from '../src/services/proxy-stats.js'
import { decryptProxyPassword } from '../src/lib/proxy-secret.js'

describe('代理管理', () => {
  let app: H3
  let site: any
  let category: any

  beforeAll(async () => {
    app = startTestApp()
    site = await createSite(app, { name: '示例站点', domain: 'example.com' })
    category = await createCategory(app, {
      siteId: site.id,
      name: '新闻',
      listUrl: 'https://example.com/news',
    })
  })

  afterAll(() => stopTestApp())

  it('创建代理：密码加密存储，响应只返回 hasPassword', async () => {
    const response = await call(
      app,
      '/api/proxies',
      json({
        name: '办公室出口',
        type: 'http',
        host: '127.0.0.1',
        port: 8080,
        username: 'user-a',
        password: 'plain-password',
      }),
    )

    expect(response.status).toBe(201)
    const proxy = response.body.data
    expect(proxy).toMatchObject({
      name: '办公室出口',
      type: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'user-a',
      hasPassword: true,
      enabled: true,
      status: 'unknown',
    })
    expect(proxy.password).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('plain-password')

    const row = getModels().proxy.findById(proxy.id)!
    expect(row.password).not.toBe('plain-password')
    expect(row.password?.startsWith('enc:v1:')).toBe(true)
    expect(decryptProxyPassword(row.password)).toBe('plain-password')
  })

  it('重复的协议 + 主机 + 端口返回 409', async () => {
    const response = await call(
      app,
      '/api/proxies',
      json({ name: '重复代理', type: 'http', host: '127.0.0.1', port: 8080 }),
    )
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
  })

  it('列表支持类型 / 启用状态 / 关键词筛选与分页上限', async () => {
    await call(
      app,
      '/api/proxies',
      json({ name: 'SOCKS 出口', type: 'socks5', host: '127.0.0.2', port: 1080, enabled: false }),
    )

    const socks = await call(app, '/api/proxies?type=socks5')
    expect(socks.body.data.total).toBe(1)
    expect(socks.body.data.items[0].type).toBe('socks5')

    const disabled = await call(app, '/api/proxies?enabled=false')
    expect(disabled.body.data.total).toBe(1)
    expect(disabled.body.data.items[0].enabled).toBe(false)

    const keyword = await call(app, '/api/proxies?keyword=办公室')
    expect(keyword.body.data.total).toBe(1)

    const tooLarge = await call(app, '/api/proxies?pageSize=101')
    expect(tooLarge.status).toBe(400)
  })

  it('更新：不传 password 保留原密码，传 null 清空', async () => {
    const created = await call(
      app,
      '/api/proxies',
      json({ name: '待更新', type: 'http', host: '127.0.0.3', port: 3128, password: 'keep-me' }),
    )
    const id = created.body.data.id

    const renamed = await call(app, `/api/proxies/${id}`, json({ name: '已改名' }, 'PATCH'))
    expect(renamed.status).toBe(200)
    expect(renamed.body.data.name).toBe('已改名')
    expect(renamed.body.data.hasPassword).toBe(true)

    const cleared = await call(app, `/api/proxies/${id}`, json({ password: null }, 'PATCH'))
    expect(cleared.body.data.hasPassword).toBe(false)
    expect(getModels().proxy.findById(id)!.password).toBeNull()
  })

  it('启停：禁用后状态变 disabled，启用后回到 unknown', async () => {
    const created = await call(
      app,
      '/api/proxies',
      json({ name: '启停测试', type: 'https', host: '127.0.0.4', port: 8443 }),
    )
    const id = created.body.data.id

    const disabled = await call(app, `/api/proxies/${id}/status`, json({ enabled: false }, 'PATCH'))
    expect(disabled.body.data.enabled).toBe(false)
    expect(disabled.body.data.status).toBe('disabled')

    const enabled = await call(app, `/api/proxies/${id}/status`, json({ enabled: true }, 'PATCH'))
    expect(enabled.body.data.enabled).toBe(true)
    expect(enabled.body.data.status).toBe('unknown')
  })

  it('连通性测试：失败时返回 ok:false 并写回状态，不抛 500', async () => {
    const created = await call(
      app,
      '/api/proxies',
      json({ name: '不可达代理', type: 'http', host: '127.0.0.2', port: 1 }),
    )
    const id = created.body.data.id

    const tested = await call(app, `/api/proxies/${id}/test`, json({ url: 'http://127.0.0.1:1/' }))
    expect(tested.status).toBe(200)
    expect(tested.body.data.ok).toBe(false)
    expect(tested.body.data.message.length).toBeGreaterThan(0)

    const detail = await call(app, `/api/proxies/${id}`)
    expect(detail.body.data.status).toBe('unavailable')
    expect(detail.body.data.lastTestAt).toBeTruthy()
    expect(detail.body.data.lastTestStatus).toBe('unavailable')
    expect(detail.body.data.failedCount).toBeGreaterThanOrEqual(1)
  })

  it('删除：被栏目引用时 409，force 解除引用后删除', async () => {
    const created = await call(
      app,
      '/api/proxies',
      json({ name: '被引用代理', type: 'http', host: '127.0.0.5', port: 8080 }),
    )
    const id = created.body.data.id
    await call(app, `/api/categories/${category.id}`, json({ proxyId: id }, 'PATCH'))

    const blocked = await call(app, `/api/proxies/${id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.categories[0].id).toBe(category.id)

    const forced = await call(app, `/api/proxies/${id}?force=true`, { method: 'DELETE' })
    expect(forced.status).toBe(200)
    expect(getModels().category.findById(category.id)!.proxyId).toBeNull()
  })

  it('使用统计：内存累加后批量写库', () => {
    const created = getModels().proxy.create({
      name: '统计代理',
      protocol: 'http',
      host: '127.0.0.6',
      port: 8080,
      enabled: 1,
    })
    recordProxyUsage(created.id, true)
    recordProxyUsage(created.id, true)
    recordProxyUsage(created.id, false)
    expect(pendingProxyStats()).toBeGreaterThan(0)

    flushProxyStats()
    const row = getModels().proxy.findById(created.id)!
    expect(row.requestCount).toBe(3)
    expect(row.successCount).toBe(2)
    expect(row.failCount).toBe(1)
    expect(row.lastUsedAt).toBeTruthy()
  })
})
