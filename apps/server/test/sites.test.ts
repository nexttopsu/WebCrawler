import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '@webcrawler/database'
import {
  call,
  createCategory,
  createSite,
  json,
  startTestApp,
  stopTestApp,
} from './helpers/app.js'
import { startSiteFixture, type SiteFixture } from './helpers/site-fixture.js'

let app: H3
let fixture: SiteFixture
let seq = 0

function domain(label: string): string {
  seq += 1
  return `${label}${seq}.example.com`
}

beforeAll(async () => {
  fixture = await startSiteFixture()
  app = startTestApp({ allowPrivateNetwork: true })
})

afterAll(async () => {
  await fixture.close()
  stopTestApp()
})

describe('网站 CRUD', () => {
  it('创建站点返回 201 与 Location', async () => {
    const host = domain('create')
    const response = await call(
      app,
      '/api/sites',
      json({ name: '创建测试', domain: host, pluginName: 'generic-site' }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe(`/api/sites/${response.body.data.id}`)
    expect(response.body.data).toMatchObject({
      name: '创建测试',
      domain: host,
      baseUrl: `https://${host}`,
      pluginName: 'generic-site',
      status: 'active',
      defaultProxyId: null,
    })
    expect(response.body.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('列表支持关键词、状态与分页', async () => {
    const host = domain('list')
    await createSite(app, { name: '列表检索站', domain: host })

    const byKeyword = await call(app, `/api/sites?keyword=${encodeURIComponent('列表检索')}`)
    expect(byKeyword.status).toBe(200)
    expect(byKeyword.body.data.total).toBe(1)
    expect(byKeyword.body.data.items[0].domain).toBe(host)
    expect(byKeyword.body.data.totalPages).toBe(1)

    const byDomain = await call(app, `/api/sites?keyword=${host}`)
    expect(byDomain.body.data.total).toBe(1)

    const inactive = await call(app, '/api/sites?status=inactive')
    expect(inactive.status).toBe(200)
    expect(
      inactive.body.data.items.every((item: { status: string }) => item.status === 'inactive'),
    ).toBe(true)
  })

  it('每页条数超过上限直接拒绝', async () => {
    const response = await call(app, '/api/sites?pageSize=101')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.details[0].path).toBe('pageSize')
  })

  it('域名格式非法时返回字段级错误', async () => {
    const response = await call(
      app,
      '/api/sites',
      json({ name: '非法域名', domain: 'https://example.com/news' }),
    )

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.details.some((item: { path: string }) => item.path === 'domain')).toBe(true)
  })

  it('baseUrl 主机名必须与域名一致', async () => {
    const response = await call(
      app,
      '/api/sites',
      json({ name: '错配', domain: domain('mismatch'), baseUrl: 'https://other.example.com' }),
    )

    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('主机名')
  })

  it('域名重复返回 409', async () => {
    const host = domain('dup')
    await createSite(app, { name: '重复域名 A', domain: host })

    const response = await call(app, '/api/sites', json({ name: '重复域名 B', domain: host }))
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.details.domain).toBe(host)
  })

  it('详情附带关联计数', async () => {
    const site = await createSite(app, { name: '详情站', domain: domain('detail') })
    await createCategory(app, { siteId: site.id, name: '栏目', listUrl: `https://${site.domain}/news` })

    const response = await call(app, `/api/sites/${site.id}`)
    expect(response.status).toBe(200)
    expect(response.body.data.counts).toEqual({ categories: 1, rules: 0, tasks: 0, articles: 0 })
    expect(response.body.data.defaultRule).toBeNull()
  })

  it('PATCH 局部更新，PUT 重置未提供的可选字段', async () => {
    const site = await createSite(app, {
      name: '更新站',
      domain: domain('patch'),
      description: '初始描述',
    })

    const patched = await call(app, `/api/sites/${site.id}`, json({ name: '改名后' }, 'PATCH'))
    expect(patched.status).toBe(200)
    expect(patched.body.data.name).toBe('改名后')
    expect(patched.body.data.description).toBe('初始描述')

    const replaced = await call(
      app,
      `/api/sites/${site.id}`,
      json({ name: '整体替换', domain: site.domain }, 'PUT'),
    )
    expect(replaced.status).toBe(200)
    expect(replaced.body.data.description).toBeNull()
    expect(replaced.body.data.status).toBe('active')
  })

  it('状态切换接口生效', async () => {
    const site = await createSite(app, { name: '状态站', domain: domain('status') })

    const response = await call(app, `/api/sites/${site.id}/status`, json({ status: 'inactive' }, 'PATCH'))
    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('inactive')

    const invalid = await call(app, `/api/sites/${site.id}/status`, json({ status: 'paused' }, 'PATCH'))
    expect(invalid.status).toBe(400)
  })

  it('不存在的站点返回 404，非法 id 返回 400', async () => {
    expect((await call(app, '/api/sites/999999')).status).toBe(404)
    expect((await call(app, '/api/sites/abc')).status).toBe(400)
  })

  it('站点下的栏目列表按站点过滤', async () => {
    const site = await createSite(app, { name: '栏目列表站', domain: domain('cats') })
    await createCategory(app, { siteId: site.id, name: '新闻', listUrl: `https://${site.domain}/news` })
    await createCategory(app, { siteId: site.id, name: '公告', listUrl: `https://${site.domain}/notice` })

    const response = await call(app, `/api/sites/${site.id}/categories`)
    expect(response.status).toBe(200)
    expect(response.body.data.total).toBe(2)
    expect(response.body.data.items.map((item: { name: string }) => item.name).sort()).toEqual([
      '公告',
      '新闻',
    ])
  })
})

describe('删除约束', () => {
  it('存在栏目时默认拒绝，force 后一并删除配置', async () => {
    const site = await createSite(app, { name: '删除站', domain: domain('del') })
    await createCategory(app, { siteId: site.id, name: '待删栏目', listUrl: `https://${site.domain}/n` })

    const blocked = await call(app, `/api/sites/${site.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.counts.categories).toBe(1)

    const forced = await call(app, `/api/sites/${site.id}?force=true`, { method: 'DELETE' })
    expect(forced.status).toBe(200)
    expect(forced.body.data).toMatchObject({ id: site.id, deleted: true, detached: 1 })

    expect((await call(app, `/api/sites/${site.id}`)).status).toBe(404)
  })

  it('存在文章时即使 force 也拒绝删除', async () => {
    const site = await createSite(app, { name: '有文章站', domain: domain('article') })
    const models = getModels()
    models.article.create({
      siteId: site.id,
      title: '文章',
      url: `https://${site.domain}/a/1`,
      status: 'published',
    })

    const blocked = await call(app, `/api/sites/${site.id}?force=true`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.counts.articles).toBe(1)
  })
})

describe('网站连接测试', () => {
  it('连通时返回状态码、耗时与标题', async () => {
    const site = await createSite(app, {
      name: '本地站点',
      domain: '127.0.0.1',
      baseUrl: fixture.origin,
    })

    const response = await call(app, `/api/sites/${site.id}/test`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      ok: true,
      statusCode: 200,
      title: 'Fixture 首页',
      url: fixture.origin,
    })
    expect(response.body.data.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('目标不可达时返回 ok=false 而不是 500', async () => {
    // 127.0.0.2 同属回环网段，但该端口没有服务，连接会被拒绝
    const site = await createSite(app, {
      name: '不可达站点',
      domain: '127.0.0.2',
      baseUrl: 'http://127.0.0.2:1',
    })

    const response = await call(app, `/api/sites/${site.id}/test`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(false)
    expect(response.body.data.statusCode).toBeNull()
    expect(typeof response.body.data.message).toBe('string')
  })
})
