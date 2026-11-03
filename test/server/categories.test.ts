import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '../../src/database/index.js'
import {
  call,
  createCategory,
  createRule,
  createSite,
  json,
  sampleConfig,
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

describe('栏目 CRUD', () => {
  it('创建栏目填充默认值', async () => {
    const site = await createSite(app, { name: '栏目站', domain: domain('cat') })
    const response = await call(
      app,
      '/api/categories',
      json({ siteId: site.id, name: '新闻', code: 'news', listUrl: `https://${site.domain}/news` }),
    )

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      siteId: site.id,
      name: '新闻',
      code: 'news',
      enabled: true,
      crawlInterval: 3600,
      sortOrder: 0,
      ruleId: null,
      proxyId: null,
    })
    expect(response.headers.get('location')).toBe(`/api/categories/${response.body.data.id}`)
  })

  it('站点不存在时返回 404', async () => {
    const response = await call(
      app,
      '/api/categories',
      json({ siteId: 999999, name: '孤儿栏目', listUrl: 'https://orphan.example.com/news' }),
    )
    expect(response.status).toBe(404)
  })

  it('规则必须属于同一站点', async () => {
    const siteA = await createSite(app, { name: 'A 站', domain: domain('a') })
    const siteB = await createSite(app, { name: 'B 站', domain: domain('b') })
    const rule = await createRule(app, { siteId: siteA.id, name: 'A 的规则', config: sampleConfig() })

    const response = await call(
      app,
      '/api/categories',
      json({ siteId: siteB.id, name: '错配栏目', listUrl: `https://${siteB.domain}/news`, ruleId: rule.id }),
    )

    expect(response.status).toBe(400)
    expect(response.body.error.details[0].path).toBe('ruleId')
  })

  it('列表地址与编号在同一站点内唯一', async () => {
    const site = await createSite(app, { name: '唯一站', domain: domain('unique') })
    const listUrl = `https://${site.domain}/news`
    await createCategory(app, { siteId: site.id, name: '新闻', code: 'news', listUrl })

    const dupUrl = await call(
      app,
      '/api/categories',
      json({ siteId: site.id, name: '另一个', code: 'other', listUrl }),
    )
    expect(dupUrl.status).toBe(409)
    expect(dupUrl.body.error.details.field).toBe('listUrl')

    const dupCode = await call(
      app,
      '/api/categories',
      json({ siteId: site.id, name: '第三个', code: 'news', listUrl: `https://${site.domain}/other` }),
    )
    expect(dupCode.status).toBe(409)
    expect(dupCode.body.error.details.field).toBe('code')
  })

  it('列表地址必须是绝对地址', async () => {
    const site = await createSite(app, { name: '绝对地址站', domain: domain('url') })
    const response = await call(
      app,
      '/api/categories',
      json({ siteId: site.id, name: '相对地址', listUrl: '/news' }),
    )
    expect(response.status).toBe(400)
  })

  it('列表支持按站点与启用状态筛选', async () => {
    const site = await createSite(app, { name: '筛选站', domain: domain('filter') })
    await createCategory(app, { siteId: site.id, name: '启用栏目', listUrl: `https://${site.domain}/a` })
    await createCategory(app, {
      siteId: site.id,
      name: '禁用栏目',
      listUrl: `https://${site.domain}/b`,
      enabled: false,
    })

    const all = await call(app, `/api/categories?siteId=${site.id}`)
    expect(all.body.data.total).toBe(2)

    const enabled = await call(app, `/api/categories?siteId=${site.id}&enabled=false`)
    expect(enabled.body.data.total).toBe(1)
    expect(enabled.body.data.items[0].name).toBe('禁用栏目')
  })

  it('PATCH 更新字段，站点归属不可变更', async () => {
    const site = await createSite(app, { name: '更新栏目站', domain: domain('cupdate') })
    const category = await createCategory(app, {
      siteId: site.id,
      name: '旧名称',
      listUrl: `https://${site.domain}/old`,
    })

    const patched = await call(
      app,
      `/api/categories/${category.id}`,
      json({ name: '新名称', crawlInterval: 600, enabled: false }, 'PATCH'),
    )
    expect(patched.status).toBe(200)
    expect(patched.body.data).toMatchObject({ name: '新名称', crawlInterval: 600, enabled: false })

    const moveSite = await call(
      app,
      `/api/categories/${category.id}`,
      json({ siteId: site.id + 1 }, 'PATCH'),
    )
    expect(moveSite.status).toBe(400)
  })

  it('详情包含站点、规则与代理摘要', async () => {
    const site = await createSite(app, { name: '详情栏目站', domain: domain('cdetail') })
    const rule = await createRule(app, { siteId: site.id, name: '栏目规则', config: sampleConfig() })
    const proxy = getModels().proxy.create({
      host: '127.0.0.1',
      port: 8080,
      protocol: 'http',
      username: 'user',
      password: 'secret',
      status: 'available',
    })

    const category = await createCategory(app, {
      siteId: site.id,
      name: '带关联的栏目',
      listUrl: `https://${site.domain}/related`,
      ruleId: rule.id,
      proxyId: proxy.id,
    })

    const response = await call(app, `/api/categories/${category.id}`)
    expect(response.status).toBe(200)
    expect(response.body.data.site).toMatchObject({ id: site.id, name: '详情栏目站' })
    expect(response.body.data.rule).toMatchObject({ id: rule.id, version: 1 })
    expect(response.body.data.proxy).toMatchObject({ id: proxy.id, host: '127.0.0.1', port: 8080 })
    // 代理凭据不得出现在响应中
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })

  it('关联不存在的代理返回 404，被禁用的代理返回 409', async () => {
    const site = await createSite(app, { name: '代理校验站', domain: domain('proxy') })

    const missing = await call(
      app,
      '/api/categories',
      json({ siteId: site.id, name: '代理不存在', listUrl: `https://${site.domain}/p1`, proxyId: 999999 }),
    )
    expect(missing.status).toBe(404)

    const disabled = getModels().proxy.create({
      host: '10.0.0.1',
      port: 3128,
      protocol: 'http',
      status: 'disabled',
    })
    const blocked = await call(
      app,
      '/api/categories',
      json({ siteId: site.id, name: '代理被禁用', listUrl: `https://${site.domain}/p2`, proxyId: disabled.id }),
    )
    expect(blocked.status).toBe(409)
  })

  it('删除栏目：有文章时拒绝，无关联时成功', async () => {
    const site = await createSite(app, { name: '删除栏目站', domain: domain('cdel') })
    const withArticle = await createCategory(app, {
      siteId: site.id,
      name: '有文章',
      listUrl: `https://${site.domain}/with`,
    })
    getModels().article.create({
      siteId: site.id,
      categoryId: withArticle.id,
      title: '文章',
      url: `https://${site.domain}/article/1`,
      status: 'published',
    })

    const blocked = await call(app, `/api/categories/${withArticle.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.counts.articles).toBe(1)

    const empty = await createCategory(app, {
      siteId: site.id,
      name: '空栏目',
      listUrl: `https://${site.domain}/empty`,
    })
    const removed = await call(app, `/api/categories/${empty.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(removed.body.data).toMatchObject({ id: empty.id, deleted: true })
  })
})

describe('栏目规则测试', () => {
  let fixtureSiteId = 0

  async function ensureFixtureSite(): Promise<number> {
    if (fixtureSiteId) return fixtureSiteId
    const site = await createSite(app, {
      name: '列表测试站',
      domain: '127.0.0.1',
      baseUrl: fixture.origin,
    })
    fixtureSiteId = site.id
    return site.id
  }

  it('抓取列表页并返回命中数量与链接预览', async () => {
    const siteId = await ensureFixtureSite()
    const rule = await createRule(app, {
      siteId,
      name: '列表测试规则',
      config: sampleConfig({
        list: { itemSelector: '.news-item', linkSelector: 'a', titleSelector: '.title' },
      }),
    })
    const category = await createCategory(app, {
      siteId,
      name: '列表测试栏目',
      listUrl: `${fixture.origin}/news`,
      ruleId: rule.id,
    })

    const response = await call(app, `/api/categories/${category.id}/test`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(true)
    // fixture 列表页共 7 个 .news-item：5 篇文章 + 1 条重复链接 + 1 条 javascript: 链接
    expect(response.body.data.itemCount).toBe(7)
    // 重复链接被去重、javascript: 链接被忽略，最终剩 5 条
    expect(response.body.data.linkCount).toBe(5)
    expect(response.body.data.links[0]).toEqual({
      url: `${fixture.origin}/article/1`,
      title: '第一篇报道：城市更新',
    })
    expect(response.body.data.mode).toBe('http')
  })

  it('未关联规则时明确报错', async () => {
    const siteId = await ensureFixtureSite()
    const category = await createCategory(app, {
      siteId,
      name: '无规则栏目',
      listUrl: `${fixture.origin}/news?case=no-rule`,
    })

    const response = await call(app, `/api/categories/${category.id}/test`, { method: 'POST' })
    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('尚未关联采集规则')
  })

  it('规则缺少 itemSelector 时明确报错', async () => {
    const siteId = await ensureFixtureSite()
    const rule = await createRule(app, {
      siteId,
      name: '缺列表选择器',
      config: { version: 1, request: { mode: 'http' } },
    })
    const category = await createCategory(app, {
      siteId,
      name: '缺选择器栏目',
      listUrl: `${fixture.origin}/news?case=no-selector`,
      ruleId: rule.id,
    })

    const response = await call(app, `/api/categories/${category.id}/test`, { method: 'POST' })
    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('itemSelector')
  })
})
