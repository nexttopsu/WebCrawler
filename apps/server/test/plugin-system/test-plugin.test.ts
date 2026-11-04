import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { CrawlContext, CrawlRuleConfig } from '../../src/shared/index.js'
import { createParser } from '../../src/core/index.js'
import { createRequestClient, type RequestClient } from '../../src/request/index.js'
import { PluginErrorCode, createPluginRegistry } from '../../src/plugin-system/index.js'
// 直接加载根目录 plugins/test-plugin/index.js，验证交付的插件文件本身
const pluginModule = (await import(
  new URL('../../../../plugins/test-plugin/index.js', import.meta.url).href
)) as {
  TestPlugin: new (options?: { name?: string; version?: string; domains?: string[] }) => any
  PluginErrorCode: Record<string, string>
  PLUGIN_NAME: string
  default: any
}

const TestPlugin = pluginModule.TestPlugin

const listHtml = readFileSync(new URL('../core/fixtures/list.html', import.meta.url), 'utf8')
const detailHtml = readFileSync(new URL('../core/fixtures/detail.html', import.meta.url), 'utf8')

let origin = ''
let server: ReturnType<typeof createServer>
let request: RequestClient
let plugin: InstanceType<typeof TestPlugin>

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path === '/list') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(listHtml)
      return
    }
    if (path === '/news/1.html' || path === '/news/3.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(detailHtml)
      return
    }
    if (path === '/news/2.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>没有标题的页面</p></body></html>')
      return
    }
    res.writeHead(404).end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`

  request = createRequestClient({ ssrf: { allowPrivateNetwork: true }, timeoutMs: 10_000 })
  plugin = new TestPlugin({ name: 'test-plugin', domains: ['127.0.0.1'] })
  plugin.initialize({ request, parser: createParser(), browser: null })
})

afterAll(async () => {
  plugin.destroy()
  request.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const rule: CrawlRuleConfig = {
  version: 1,
  list: { itemSelector: '.news-item', linkSelector: '.title', titleSelector: '.title' },
  detail: {
    fields: {
      title: { type: 'text', selector: '.article-title', required: true },
      author: { type: 'text', selector: '.author' },
      publishTime: { type: 'text', selector: '.publish-time' },
      content: { type: 'html', selector: '.article-content' },
    },
  },
  clean: { removeSelectors: ['.ad'] },
}

function makeContext(url = `${origin}/list`): CrawlContext {
  return {
    site: { id: '1', name: '测试站', domain: '127.0.0.1', baseUrl: origin },
    category: { id: '10', siteId: '1', name: '新闻', listUrl: `${origin}/list` },
    rule: { version: 1, config: rule },
    url,
    requestOptions: {},
    proxy: null,
    signal: new AbortController().signal,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    metadata: {},
  }
}

describe('TestPlugin：身份与站点匹配', () => {
  it('插件身份与 plugin.json 清单一致', () => {
    expect(plugin.name).toBe('test-plugin')
    expect(plugin.version).toBe('1.0.0')
    expect(plugin.type).toBe('source')
  })

  it('按域名匹配，包含子域名', () => {
    expect(plugin.match(`${origin}/list`)).toBe(true)
    expect(plugin.match('https://example.com/list')).toBe(false)
  })

  it('子域名匹配基于真实域名（IP 地址无子域名概念）', () => {
    const examplePlugin = new TestPlugin({ domains: ['example.com'] })
    expect(examplePlugin.match('https://news.example.com/a')).toBe(true)
    expect(examplePlugin.match('https://www.example.com/a')).toBe(true)
    expect(examplePlugin.match('https://notexample.com/a')).toBe(false)
  })

  it('非法 URL 不匹配', () => {
    expect(plugin.match('not-a-url')).toBe(false)
  })

  it('未配置域名时匹配所有站点', () => {
    const anySite = new TestPlugin()
    expect(anySite.match('https://any.example.com/a')).toBe(true)
  })
})

describe('TestPlugin：错误路径', () => {
  it('未初始化时调用能力抛 NOT_INITIALIZED', async () => {
    const fresh = new TestPlugin()
    const error = await fresh.getList(makeContext()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: PluginErrorCode.NOT_INITIALIZED })
  })

  it('不负责的地址抛 NOT_MATCHED', async () => {
    const error = await plugin
      .parseDetail(makeContext(), { url: 'https://other.example.com/a', sourceUrl: origin })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: PluginErrorCode.NOT_MATCHED })
  })

  it('规则缺少 itemSelector 时抛 EXECUTION_FAILED', async () => {
    const context = makeContext()
    context.rule = { version: 1, config: { version: 1, detail: { fields: {} } } }
    const error = await plugin.getList(context).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: PluginErrorCode.EXECUTION_FAILED })
  })

  it('请求 404 时抛 EXECUTION_FAILED 并附带状态码', async () => {
    const context = makeContext()
    const error = await plugin
      .parseDetail(context, { url: `${origin}/news/missing.html`, sourceUrl: context.url })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: PluginErrorCode.EXECUTION_FAILED })
    expect((error as { details?: { status?: number } }).details?.status).toBe(404)
  })
})

describe('TestPlugin：采集流程', () => {
  it('列表提取：过滤伪协议、去重并规范化 URL', async () => {
    const links = await plugin.getList(makeContext())
    expect(links.map((link: { url: string }) => link.url)).toEqual([
      `${origin}/news/1.html`,
      `${origin}/news/2.html`,
      `${origin}/news/3.html`,
    ])
    expect(links[0]?.title).toBe('第一篇报道')
    expect(links[0]?.sourceUrl).toBe(`${origin}/list`)
  })

  it('详情解析：产出完整 ArticleData', async () => {
    const context = makeContext()
    const links = await plugin.getList(context)
    const article = await plugin.parseDetail(context, links[0])

    expect(article.siteId).toBe('1')
    expect(article.categoryId).toBe('10')
    expect(article.title).toBe('第一篇报道：采集平台上线')
    expect(article.author).toBe('张三')
    expect(article.articleTime).toBe('2026-01-01 10:00')
    expect(article.content).toContain('第一段正文')
    expect(article.content).not.toContain('document.write')
    expect(article.content).not.toContain('这里是广告')
    expect(article.metadata).toMatchObject({ sourceUrl: `${origin}/list`, plugin: 'test-plugin' })
  })

  it('必填字段缺失时抛 VALIDATION_FAILED', async () => {
    const context = makeContext()
    const error = await plugin
      .parseDetail(context, { url: `${origin}/news/2.html`, sourceUrl: context.url })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: PluginErrorCode.VALIDATION_FAILED })
    expect((error as { details?: { missing?: string[] } }).details?.missing).toContain('title')
  })
})

describe('TestPlugin：注册表集成', () => {
  it('注册实例、按 URL 查找、批量初始化与销毁', async () => {
    const registry = createPluginRegistry()
    const a = new TestPlugin({ name: 'alpha', domains: ['a.example.com'] })
    const b = new TestPlugin({ name: 'beta', domains: ['b.example.com'] })
    registry.registerPlugin(a)
    registry.registerPlugin(b)

    expect(registry.listPlugins().map((item) => item.name)).toEqual(['alpha', 'beta'])
    expect(registry.findSitePlugin('https://a.example.com/news')?.name).toBe('alpha')
    expect(registry.findSitePlugin('https://c.example.com/news')).toBeUndefined()

    const failures = await registry.initializeAll({ request, parser: createParser(), browser: null })
    expect(failures).toEqual([])
    await registry.destroyAll()
  })
})

describe('TestPlugin：服务端动态加载契约', () => {
  it('default 导出为插件实例，与清单一致且可直接注册', () => {
    const instance = pluginModule.default
    expect(instance).toBeInstanceOf(TestPlugin)
    expect(instance.name).toBe('test-plugin')
    expect(instance.version).toBe('1.0.0')
    expect(instance.type).toBe('source')
    expect(typeof instance.initialize).toBe('function')
    expect(typeof instance.destroy).toBe('function')
    expect(typeof instance.match).toBe('function')
    expect(typeof instance.getList).toBe('function')
    expect(typeof instance.parseDetail).toBe('function')
    // 配置来自 plugin.json 的 config.domains
    expect(instance.domains).toEqual(['example.com', '127.0.0.1'])
    expect(instance.match('https://www.example.com/a')).toBe(true)
    expect(instance.match('https://other.com/a')).toBe(false)
  })
})
