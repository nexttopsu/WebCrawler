import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { CrawlContext, CrawlRuleConfig, FieldRule } from '../../src/shared/index.js'
import { createParser } from '../../src/core/index.js'
import { createRequestClient, type RequestClient } from '../../src/request/index.js'
import {
  GenericSitePlugin,
  PluginError,
  PluginErrorCode,
  PluginType,
  createGenericSitePlugin,
  createPluginRegistry,
} from '../../src/plugin-system/index.js'

const listHtml = readFileSync(
  new URL('../core/fixtures/list.html', import.meta.url),
  'utf8',
)
const detailHtml = readFileSync(
  new URL('../core/fixtures/detail.html', import.meta.url),
  'utf8',
)

const detailFields: Record<string, FieldRule> = {
  title: { type: 'text', selector: '.article-title', required: true },
  author: { type: 'text', selector: '.author' },
  publishTime: { type: 'text', selector: '.publish-time' },
  content: { type: 'html', selector: '.article-content' },
}

let origin = ''
let server: ReturnType<typeof createServer>
let request: RequestClient
let plugin: GenericSitePlugin

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
  plugin = createGenericSitePlugin({ name: 'fixture-site', domains: ['127.0.0.1'] })
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
  detail: { fields: detailFields },
  clean: { removeSelectors: ['.ad'] },
}

function makeContext(): CrawlContext {
  return {
    site: { id: '1', name: '测试站', domain: '127.0.0.1', baseUrl: origin },
    category: { id: '10', siteId: '1', name: '新闻', listUrl: `${origin}/list` },
    rule: { version: 1, config: rule },
    url: `${origin}/list`,
    requestOptions: {},
    proxy: null,
    signal: new AbortController().signal,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    metadata: {},
  }
}

describe('GenericSitePlugin：站点匹配', () => {
  it('按域名匹配，包含子域名', () => {
    expect(plugin.match('https://127.0.0.1/list')).toBe(true)
    expect(plugin.match('https://example.com/list')).toBe(false)
  })

  it('未配置域名时匹配所有站点', () => {
    const anySite = new GenericSitePlugin()
    expect(anySite.match('https://any.example.com/a')).toBe(true)
    expect(anySite.name).toBe('generic-site')
    expect(anySite.type).toBe(PluginType.SOURCE)
  })

  it('未初始化时调用能力会明确报错', async () => {
    const fresh = new GenericSitePlugin()
    const error = await fresh.getList(makeContext()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: PluginErrorCode.NOT_INITIALIZED })
  })
})

describe('GenericSitePlugin：采集流程（本阶段验收）', () => {
  it('列表 → 详情 → ArticleData → 管道输出', async () => {
    const context = makeContext()
    const links = await plugin.getList(context)

    expect(links.map((link) => link.url)).toEqual([
      `${origin}/news/1.html`,
      `${origin}/news/2.html`,
      `${origin}/news/3.html`,
    ])

    const article = await plugin.parseDetail(context, links[0])

    expect(article.title).toBe('第一篇报道：采集平台上线')
    expect(article.author).toBe('张三')
    expect(article.content).toBeDefined()
    expect(article.articleTime).toBe('2026-01-01 10:00')
    expect(article.siteId).toBe('1')
    expect(article.metadata).toMatchObject({ sourceUrl: `${origin}/list` })
  })

  it('数据校验失败时抛出 VALIDATION_FAILED', async () => {
    const context = makeContext()
    const error = await plugin
      .parseDetail(context, { url: `${origin}/news/2.html`, sourceUrl: context.url })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PluginError)
    expect((error as PluginError).code).toBe(PluginErrorCode.VALIDATION_FAILED)
    expect((error as PluginError).pluginName).toBe('fixture-site')
  })

  it('不负责的地址抛出 NOT_MATCHED', async () => {
    const error = await plugin
      .parseDetail(makeContext(), { url: 'https://other.example.com/a', sourceUrl: origin })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ code: PluginErrorCode.NOT_MATCHED })
  })

  it('请求失败包装为 EXECUTION_FAILED，并保留原始错误码', async () => {
    const context = makeContext()
    const error = await plugin
      .parseDetail(context, { url: `${origin}/news/missing.html`, sourceUrl: context.url })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ code: PluginErrorCode.EXECUTION_FAILED })
    expect((error as PluginError).details).toMatchObject({ stage: 'extract-detail', code: 'HTTP_STATUS' })
  })
})

describe('插件注册表：运行时实例', () => {
  it('注册实例、按 URL 查找、初始化与销毁', async () => {
    const registry = createPluginRegistry()
    const a = createGenericSitePlugin({ name: 'site-a', domains: ['a.example.com'] })
    const b = createGenericSitePlugin({ name: 'site-b', domains: ['b.example.com'] })
    registry.registerPlugin(a)
    registry.registerPlugin(b)

    expect(registry.listPlugins().map((item) => item.name)).toEqual(['site-a', 'site-b'])
    expect(registry.findSitePlugin('https://a.example.com/news')?.name).toBe('site-a')
    expect(registry.findSitePlugin('https://c.example.com/news')).toBeUndefined()

    const failures = await registry.initializeAll({ request, parser: createParser(), browser: null })
    expect(failures).toEqual([])

    await registry.destroyAll()
  })

  it('重复注册同一实例报错', () => {
    const registry = createPluginRegistry()
    registry.registerPlugin(createGenericSitePlugin({ name: 'dup' }))
    expect(() => registry.registerPlugin(createGenericSitePlugin({ name: 'dup' }))).toThrow()
  })
})
