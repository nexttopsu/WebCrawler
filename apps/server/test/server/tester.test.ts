/**
 * 可视化规则测试器 API（第四阶段）验收测试。
 *
 * 全部请求都打本地 fixture 站点，覆盖任务书「验收测试」列出的场景：
 * 普通列表、多条链接、文章详情、页码分页（配置）、正文图片、SPA、Selector 无/多匹配、
 * 必填缺失、脚本隔离、XSS 预览防护、SSRF 拦截。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '../../src/database/index.js'
import type { CrawlRuleConfig } from '../../src/shared/index.js'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { createLogger } from '../../src/server/lib/logger.js'
import { createPluginRegistry } from '../../src/plugin-system/index.js'
import { call, startTestApp, stopTestApp } from './helpers/app.js'
import { startSiteFixture, type SiteFixture } from './helpers/site-fixture.js'

let app: H3
let fixture: SiteFixture

beforeAll(async () => {
  app = startTestApp({ allowPrivateNetwork: true })
  fixture = await startSiteFixture()
}, 60_000)

afterAll(async () => {
  await fixture.close()
  stopTestApp()
})

/* -------------------------------------------------------------------------- */
/* 页面快照                                                                    */
/* -------------------------------------------------------------------------- */

describe('POST /api/tester/snapshot', () => {
  it('返回清洗后的快照：去脚本 / 事件属性 / javascript 协议，并注入 base', async () => {
    const response = await call(app, '/api/tester/snapshot', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/news` }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.title).toBe('新闻列表 - Fixture 站点')
    expect(data.statusCode).toBe(200)
    expect(data.base).toBe(`${fixture.origin}/news`)

    // 脚本隔离与 XSS 防护
    expect(data.html).not.toContain('<script')
    expect(data.html).not.toMatch(/onerror=/i)
    expect(data.html).not.toContain('javascript:')
    // 相对地址解析基准
    expect(data.html).toContain(`<base href="${fixture.origin}/news">`)
    // 正文结构仍然保留，可正常点选
    expect(data.html).toContain('news-item')
  })

  it('目标页面 404 时返回 ok:false 而不是 500', async () => {
    const response = await call(app, '/api/tester/snapshot', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/not-exists` }),
    })

    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(false)
    expect(response.body.data.message).toContain('404')
  })

  it('非法 URL 返回 400 字段级错误', async () => {
    const response = await call(app, '/api/tester/snapshot', {
      method: 'POST',
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('浏览器模式可拿到 SPA 渲染后的 DOM（脚本在隔离环境执行后清洗）', async () => {
    const response = await call(app, '/api/tester/snapshot', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/spa`, mode: 'browser' }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.mode).toBe('browser')
    expect(data.html).toContain('SPA 第一篇')
    // 渲染后的页面同样不清洗掉脚本是不可能的：快照里不允许出现 script
    expect(data.html).not.toContain('<script')
  }, 40_000)
})

describe('SSRF 防护', () => {
  it('默认策略下拒绝私网地址，且返回可读错误而不是崩溃', async () => {
    // 复用同一个数据库，只换一个「严格 SSRF」的应用实例，
    // 避免反复 init/close 数据库影响同一文件中的其它用例。
    const strictApp = createApp({
      config: { ...loadConfig({}), logLevel: 'error', allowPrivateNetwork: false, debugDatabaseFile: ':memory:' },
      logger: createLogger('error'),
    })

    const response = await call(strictApp, '/api/tester/snapshot', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/news` }),
    })
    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(false)
    expect(response.body.data.html).toBe('')
    expect(response.body.data.message.length).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/* 列表测试                                                                    */
/* -------------------------------------------------------------------------- */

describe('POST /api/tester/list', () => {
  it('命中列表项、提取链接、统计重复', async () => {
    const response = await call(app, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/news`,
        list: { itemSelector: '.news-item', linkSelector: 'a', titleSelector: '.title' },
      }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.itemCount).toBe(7)
    expect(data.linkCount).toBe(5)
    expect(data.duplicateCount).toBe(1)
    expect(data.links[0]).toEqual({
      url: `${fixture.origin}/article/1`,
      title: '第一篇报道：城市更新',
      coverUrl: null,
      // 未配置列表字段映射时，内置字段一律为 null
      author: null,
      summary: null,
      articleTime: null,
    })
  })

  it('选择器无匹配时 itemCount 为 0 并给出提示', async () => {
    const response = await call(app, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/news`,
        list: { itemSelector: '.no-such-item' },
      }),
    })

    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(true)
    expect(response.body.data.itemCount).toBe(0)
    expect(response.body.data.message).toContain('没有命中')
  })

  it('列表字段映射支持文章内置字段，并在预览里回显文章时间', async () => {
    const response = await call(app, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/news`,
        list: {
          itemSelector: '.news-item',
          fields: {
            url: { type: 'attr', selector: 'a.title', attribute: 'href', required: true },
            title: { type: 'text', selector: 'a.title', required: true },
            articleTime: { type: 'text', selector: '.time' },
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.links[0]).toMatchObject({
      title: '第一篇报道：城市更新',
      articleTime: '2026-01-01 09:00',
    })
  })

  it('itemSelector 直接指向链接时，字段 Selector 留空即取该链接节点', async () => {
    const response = await call(app, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/news`,
        list: {
          itemSelector: '.news-item a.title',
          fields: {
            url: { type: 'attr', attribute: 'href', required: true },
            title: { type: 'text', required: true },
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.links[0]).toMatchObject({
      url: `${fixture.origin}/article/1`,
      title: '第一篇报道：城市更新',
    })
  })

  it('支持页码分页配置（query）且不因未实现的分页类型静默通过', async () => {
    const okResponse = await call(app, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/paged?page=1`,
        list: { itemSelector: '.post', linkSelector: '.post-link' },
        pagination: { type: 'query', parameter: 'page' },
      }),
    })
    expect(okResponse.status).toBe(200)
    expect(okResponse.body.data.itemCount).toBe(2)

    const cursorResponse = await call(app, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/paged?page=1`,
        list: { itemSelector: '.post' },
        pagination: { type: 'cursor', cursorParameter: 'cursor' },
      }),
    })
    expect(cursorResponse.status).toBe(400)
    expect(cursorResponse.body.error.message).toContain('cursor')
  })
})

/* -------------------------------------------------------------------------- */
/* 详情测试                                                                    */
/* -------------------------------------------------------------------------- */

describe('POST /api/tester/detail', () => {
  it('提取字段、清洗正文、解析正文图片', async () => {
    const response = await call(app, '/api/tester/detail', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/article/2`,
        fields: {
          title: { type: 'text', selector: '.article-title', required: true },
          author: { type: 'text', selector: '.author' },
          publishTime: { type: 'text', selector: '.publish-time' },
          content: { type: 'html', selector: '.article-content' },
          images: { type: 'attr', selector: 'img', attribute: 'src', multiple: true },
        },
        clean: { removeSelectors: ['.ad'] },
      }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.missing).toEqual([])

    const byKey = Object.fromEntries(data.fields.map((field: any) => [field.key, field]))
    expect(byKey.title.value).toBe('第二篇报道：轨道交通')
    expect(byKey.title.matched).toBe(1)
    expect(byKey.author.value).toBe('记者乙')
    expect(byKey.publishTime.value).toBe('2026-01-02 10:30')

    // 字段诊断里的 value 是原始提取值；清洗后的正文在 article 上
    expect(byKey.content.value).toContain('新线路进入试运行阶段')

    // 管道产出的完整文章数据可用于正式采集落库
    const article = data.article
    expect(article.title).toBe('第二篇报道：轨道交通')
    expect(article.content).toContain('新线路进入试运行阶段')
    expect(article.content).not.toContain('广告位')
    expect(article.content).not.toContain('<script')
    // 正文图片不再单独输出，映射的 images 字段作为自定义字段进 metadata
    expect(article.metadata.images).toContain('/images/2.png')
  })

  it('必填字段缺失时 ok:false，并列出缺失字段', async () => {
    const response = await call(app, '/api/tester/detail', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/article/3`,
        fields: {
          title: { type: 'text', selector: '.not-exists', required: true },
          content: { type: 'html', selector: '.article-content' },
        },
      }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(false)
    expect(data.missing).toContain('title')
    expect(data.fields.find((field: any) => field.key === 'title').ok).toBe(false)
  })

  it('详情只配 content 也能出文章（标题回退页面标题）', async () => {
    const response = await call(app, '/api/tester/detail', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/article/1`,
        fields: { content: { type: 'html', selector: '.article-content', required: true } },
      }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.article.title).toBeTruthy()
    expect(data.article.content).toBeTruthy()
    expect(data.errors).toEqual([])
  })

  it('空字段映射返回 400', async () => {
    const response = await call(app, '/api/tester/detail', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/article/1`, fields: {} }),
    })
    expect(response.status).toBe(400)
  })
})

/* -------------------------------------------------------------------------- */
/* 规则校验与辅助接口                                                          */
/* -------------------------------------------------------------------------- */

describe('POST /api/tester/rule/validate', () => {
  it('合法规则通过第三阶段 Schema', async () => {
    const config: CrawlRuleConfig = {
      version: 1,
      list: { itemSelector: '.news-item', linkSelector: 'a' },
      fields: { title: { type: 'text', selector: 'h1', required: true } },
    }
    const response = await call(app, '/api/tester/rule/validate', {
      method: 'POST',
      body: JSON.stringify({ config }),
    })
    expect(response.status).toBe(200)
    expect(response.body.data.valid).toBe(true)
    expect(response.body.data.issues).toEqual([])
  })

  it('未实现的分页类型给出字段级错误，不静默通过', async () => {
    const response = await call(app, '/api/tester/rule/validate', {
      method: 'POST',
      body: JSON.stringify({
        config: {
          version: 1,
          list: { itemSelector: '.news-item' },
          pagination: { type: 'next', nextSelector: '.next' },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.body.data.valid).toBe(false)
    expect(JSON.stringify(response.body.data.issues)).toContain('next')
  })
})

describe('GET /api/proxies', () => {
  it('只返回摘要，不泄漏用户名密码', async () => {
    getModels().proxy.create({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'secret-user',
      password: 'secret-pass',
      status: 'active',
    })

    const response = await call(app, '/api/proxies')
    expect(response.status).toBe(200)
    expect(response.body.data.items.length).toBe(1)
    const item = response.body.data.items[0]
    expect(item).toMatchObject({ type: 'http', host: '127.0.0.1', port: 8080, hasPassword: true })
    expect(item.password).toBeUndefined()
    expect(item.passwordHash).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('secret-pass')
  })
})

describe('HTTP 语义', () => {
  it('GET /api/tester/snapshot 返回 405 并带 Allow', async () => {
    const response = await call(app, '/api/tester/snapshot')
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toContain('POST')
  })
})

/* -------------------------------------------------------------------------- */
/* 全流程插件试跑                                                              */
/* -------------------------------------------------------------------------- */

describe('测试器：全流程插件', () => {
  let pluginApp: H3
  const registry = createPluginRegistry()

  beforeAll(() => {
    // 注入注册表时由测试自己决定注册什么：createApp 不会自动注册内置插件
    pluginApp = createApp({
      config: { ...loadConfig({}), logLevel: 'error', allowPrivateNetwork: true, proxySecretKey: 'test-secret-key-0123456789', debugDatabaseFile: ':memory:' },
      logger: createLogger('error'),
      plugins: registry,
    })
    registry.register({
      config: { id: 'fixture-flow', name: 'Fixture 全流程', type: 'flow' },
      source: 'src/plugins/fixture-flow.ts',
      getList: async (url: string) => {
        const base = url.endsWith('/') ? url : `${url}/`
        return [{ url: new URL('1.html', base).href, title: '插件列表标题' }]
      },
      getDetail: async () => ({
        title: '插件详情标题',
        content: '<p>插件正文</p>',
        articleTime: '2026-05-05',
        extra: { from: 'plugin' },
      }),
    })
    registry.register({
      config: { id: 'fixture-parser', name: 'Fixture 解析器', type: 'parser' },
      source: 'src/plugins/fixture-parser.ts',
      parseDetail: async (_url, fields) => ({ ...fields, title: `${String(fields.title ?? '')}!` }),
    })
  })

  it('列表：选中插件后不用写抽取规则，直接返回插件给的条目', async () => {
    const response = await call(pluginApp, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/news`, list: { plugin: 'fixture-flow' } }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    expect(data.links).toHaveLength(1)
    expect(data.links[0].url).toBe(`${fixture.origin}/news/1.html`)
    expect(data.links[0].title).toBe('插件列表标题')
    // 插件自己发请求，平台侧没有状态码
    expect(data.statusCode).toBeNull()
  })

  it('详情：选中插件后由 getDetail 直接给出字段', async () => {
    const response = await call(pluginApp, '/api/tester/detail', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/news/1.html`, plugin: 'fixture-flow' }),
    })

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    const keys = data.fields.map((field: { key: string }) => field.key)
    expect(keys).toEqual(expect.arrayContaining(['title', 'content', 'articleTime']))
    expect(data.fields.find((field: { key: string }) => field.key === 'title').value).toBe('插件详情标题')
  })

  it('解析器插件仍按字段后处理链执行（与全流程插件并存）', async () => {
    const response = await call(pluginApp, '/api/tester/detail', {
      method: 'POST',
      body: JSON.stringify({
        url: `${fixture.origin}/article/2`,
        fields: { title: { type: 'text', selector: '.article-title', required: true } },
        parserPlugins: ['fixture-parser'],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(true)
    // 字段诊断是原始提取值；解析器插件的处理结果体现在最终 article 上
    expect(response.body.data.fields.find((field: { key: string }) => field.key === 'title').value).toBe(
      '第二篇报道：轨道交通',
    )
    expect(response.body.data.article.title).toBe('第二篇报道：轨道交通!')
  })

  it('把插件挂到它不支持的阶段时报错，而不是静默返回空', async () => {
    const response = await call(pluginApp, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/news`, list: { plugin: 'fixture-parser' } }),
    })

    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(false)
    expect(response.body.data.message).toContain('解析器')
  })

  it('既没插件也没选择器时报 400', async () => {
    const response = await call(pluginApp, '/api/tester/list', {
      method: 'POST',
      body: JSON.stringify({ url: `${fixture.origin}/news`, list: {} }),
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })
})
