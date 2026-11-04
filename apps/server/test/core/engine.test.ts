import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CrawlContext, CrawlRuleConfig, FieldRule } from '../../src/shared/index.js'
import {
  RequestErrorCode,
  createBrowserClient,
  createRequestClient,
  type BrowserClient,
  type RequestClient,
} from '../../src/request/index.js'
import { CrawlEngine } from '../../src/core/index.js'
import type { PluginRegistry } from '../../src/plugin-system/index.js'
import { createParserPluginRunner } from '../../src/server/services/task-executor.js'

const listHtml = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8')
const detailHtml = readFileSync(new URL('./fixtures/detail.html', import.meta.url), 'utf8')

const SPA_HTML = `<!doctype html><html><head><title>渲染页</title></head><body>
  <div id="root"></div>
  <div class="ad">广告</div>
  <script>
    document.getElementById('root').innerHTML =
      '<h1 class="article-title">脚本渲染的标题</h1><div class="article-content"><p>脚本文本</p></div>';
  </script>
</body></html>`

const detailFields: Record<string, FieldRule> = {
  title: { type: 'text', selector: '.article-title', required: true },
  author: { type: 'text', selector: '.author' },
  publishTime: { type: 'text', selector: '.publish-time' },
  content: { type: 'html', selector: '.article-content' },
}

let origin = ''
let server: ReturnType<typeof createServer>
let request: RequestClient
let browser: BrowserClient
let engine: CrawlEngine

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const html = (body: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }

    if (path === '/list') return html(listHtml)
    if (path === '/news/1.html' || path === '/news/3.html') return html(detailHtml)
    if (path === '/news/2.html') return html('<html><body><p>这篇文章没有标题</p></body></html>')
    if (path === '/spa') return html(SPA_HTML)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`

  request = createRequestClient({ ssrf: { allowPrivateNetwork: true }, timeoutMs: 10_000 })
  browser = createBrowserClient({ timeoutMs: 20_000, ssrf: { allowPrivateNetwork: true } })
  engine = new CrawlEngine({ request, browser })
}, 60_000)

afterAll(async () => {
  request.close()
  await browser.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeRule(overrides: Partial<CrawlRuleConfig> = {}): CrawlRuleConfig {
  return {
    version: 1,
    request: { timeoutMs: 5000 },
    list: {
      itemSelector: '.news-item',
      linkSelector: '.title',
      titleSelector: '.title',
    },
    detail: { fields: detailFields },
    clean: { removeSelectors: ['.ad'] },
    ...overrides,
  }
}

function makeContext(config: CrawlRuleConfig = makeRule(), signal?: AbortSignal): CrawlContext {
  return {
    site: { id: '1', name: '测试站', domain: '127.0.0.1', baseUrl: origin },
    category: { id: '10', siteId: '1', name: '新闻', listUrl: `${origin}/list` },
    rule: { version: 1, config },
    url: `${origin}/list`,
    requestOptions: {},
    proxy: null,
    signal: signal ?? new AbortController().signal,
    logger: silentLogger,
    metadata: {},
  }
}

describe('采集引擎：列表提取', () => {
  it('提取链接并转绝对地址、去重、去跟踪参数', async () => {
    const page = await engine.listPage(makeContext())

    expect(page.links.map((link) => link.url)).toEqual([
      `${origin}/news/1.html`,
      `${origin}/news/2.html`,
      `${origin}/news/3.html`,
    ])
    expect(page.links[0]?.title).toBe('第一篇报道')
    expect(page.links[0]?.sourceUrl).toBe(`${origin}/list`)
    // fixture 第 4 个列表项重复指向 /news/1.html，应被统计为重复
    expect(page.itemCount).toBe(4)
    expect(page.duplicateCount).toBe(1)
  })

  it('缺少列表规则时给出明确错误', async () => {
    const context = makeContext(makeRule({ list: undefined }))
    await expect(engine.listLinks(context)).rejects.toThrow('list.itemSelector')
  })

  it('支持 XPath 列表规则', async () => {
    const context = makeContext(
      makeRule({
        list: {
          itemSelector: '//div[@class="news-item"]',
          itemSelectorType: 'xpath',
          linkSelector: './/a[@class="title"]',
          titleSelector: './/a[@class="title"]',
        },
      }),
    )
    const links = await engine.listLinks(context)
    expect(links).toHaveLength(3)
    expect(links[2]?.title).toBe('第三篇报道')
  })

  it('配置 coverSelector 时从列表项提取封面图', async () => {
    const context = makeContext(
      makeRule({
        list: {
          itemSelector: '.news-item',
          linkSelector: '.title',
          titleSelector: '.title',
          coverSelector: 'img.thumb',
          coverAttribute: 'data-src',
        },
      }),
    )
    const page = await engine.listPage(context)

    // 相对地址转绝对；伪协议（javascript:）封面被丢弃，不回退到其他属性
    expect(page.links[0]?.coverUrl).toBe(`${origin}/upload/cover-1.jpg`)
    expect(page.links[1]?.coverUrl).toBe(`${origin}/upload/cover-2.jpg`)
    expect(page.links[2]?.coverUrl).toBeUndefined()
    // 未配置 coverSelector 时不提取封面
    const plain = await engine.listPage(makeContext())
    expect(plain.links[0]?.coverUrl).toBeUndefined()
  })

  it('列表阶段只执行 list.parserPlugins，详情阶段只执行顶层 parserPlugins', async () => {
    const calls: Array<{ name: string; stage: string }> = []
    // 最小注册表桩：任何名字都返回一个会记录调用的解析器插件
    const registry = {
      getParserPlugin: (name: string) => ({
        name,
        type: 'parser',
        transform: async (input: { data: Record<string, unknown>; stage: string }) => {
          calls.push({ name, stage: input.stage })
          return { ...input.data, title: `[${input.stage}] ${String(input.data.title ?? '')}` }
        },
      }),
    } as unknown as PluginRegistry
    const pluginEngine = new CrawlEngine({
      request,
      browser,
      parserPluginRunner: createParserPluginRunner(registry),
    })

    const context = makeContext(
      makeRule({
        list: {
          itemSelector: '.news-item',
          fields: {
            title: { type: 'text', selector: '.title', required: true },
            url: { type: 'attr', selector: '.title', attribute: 'href', required: true },
          },
          parserPlugins: ['list-decrypt'],
        },
        // 顶层插件只作用于详情阶段
        parserPlugins: ['detail-decrypt'],
      }),
    )

    const page = await pluginEngine.listPage(context)
    expect(page.links[0]?.title).toBe('[list] 第一篇报道')
    // 列表阶段每个列表项各执行一次，且只执行列表插件
    expect(calls).toHaveLength(4)
    expect(calls.every((call) => call.name === 'list-decrypt' && call.stage === 'list')).toBe(true)

    calls.length = 0
    const result = await pluginEngine.crawlCategory(context)
    expect(calls.some((call) => call.name === 'detail-decrypt' && call.stage === 'detail')).toBe(true)
    expect(calls.some((call) => call.name === 'list-decrypt' && call.stage === 'list')).toBe(true)
    // 详情阶段不会混入列表插件，反之亦然
    expect(calls.some((call) => call.name === 'list-decrypt' && call.stage === 'detail')).toBe(false)
    expect(calls.some((call) => call.name === 'detail-decrypt' && call.stage === 'list')).toBe(false)
    // 详情标题取自详情页字段，只经过详情插件（列表前缀不参与）
    expect(result.articles[0]?.title).toBe('[detail] 第一篇报道：采集平台上线')
  })

  it('excludeSelectors 优先级最高：字段提取前先删除命中的节点', async () => {
    const listFields: Record<string, FieldRule> = {
      title: { type: 'text', selector: '.title', required: true },
      url: { type: 'attr', selector: '.title', attribute: 'href', required: true },
      time: { type: 'text', selector: '.time' },
    }

    // 未配置排除时 time 能提取到
    const plain = await engine.listPage(
      makeContext(makeRule({ list: { itemSelector: '.news-item', fields: listFields } })),
    )
    expect((plain.links[0]?.metadata as Record<string, unknown>).time).toBe('2026-01-01')

    // 列表排除 .time：time 字段消失，title / url 不受影响
    const excluded = await engine.listPage(
      makeContext(
        makeRule({ list: { itemSelector: '.news-item', fields: listFields, excludeSelectors: ['.time'] } }),
      ),
    )
    expect(excluded.links[0]?.metadata?.time).toBeUndefined()
    expect(excluded.links[0]?.title).toBe('第一篇报道')
    expect(excluded.links[0]?.url).toBe(`${origin}/news/1.html`)

    // 详情排除 .author：author 字段提取不到
    const context = makeContext(
      makeRule({ list: { itemSelector: '.news-item', fields: listFields }, excludeSelectors: ['.author'] }),
    )
    const result = await engine.crawlCategory(context)
    expect(result.articles[0]?.author).toBeUndefined()
    expect(result.articles[0]?.title).toBeTruthy()
  })
})

describe('采集引擎：栏目采集', () => {
  it('列表 → 详情 → ArticleData，并隔离单篇失败', async () => {
    const result = await engine.crawlCategory(makeContext())

    expect(result.links).toHaveLength(3)
    expect(result.articles).toHaveLength(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.url).toBe(`${origin}/news/2.html`)
    expect(result.errors[0]?.stage).toBe('detail')
    expect(result.errors[0]?.code).toBe('VALIDATION_FAILED')
    expect(result.stats).toMatchObject({ linkCount: 3, articleCount: 2, failedCount: 1 })

    const article = result.articles[0]!
    expect(article.title).toBe('第一篇报道：采集平台上线')
    expect(article.content).toContain('第一段正文')
    expect(article.articleTime).toBe('2026-01-01 10:00')
  })

  it('详情页没拍到封面时用列表封面兜底', async () => {
    // detailFields 未映射 cover，封面应来自列表阶段的提取
    const context = makeContext(
      makeRule({
        list: {
          itemSelector: '.news-item',
          linkSelector: '.title',
          titleSelector: '.title',
          coverSelector: 'img.thumb',
          coverAttribute: 'data-src',
        },
      }),
    )
    const result = await engine.crawlCategory(context)

    expect(result.articles).toHaveLength(2)
    expect(result.articles[0]?.coverUrl).toBe(`${origin}/upload/cover-1.jpg`)
    // 第三篇列表封面是伪协议被丢弃，且详情页无封面 → 保持 null
    expect(result.articles[1]?.coverUrl).toBeNull()
  })

  it('limit 限制单次处理的文章数量', async () => {
    const result = await engine.crawlCategory(makeContext(), { limit: 1 })
    expect(result.articles).toHaveLength(1)
    expect(result.errors).toHaveLength(0)
  })

  it('listOnly 只抓列表', async () => {
    const result = await engine.crawlCategory(makeContext(), { listOnly: true })
    expect(result.links).toHaveLength(3)
    expect(result.articles).toHaveLength(0)
  })
})

describe('采集引擎：异常处理', () => {
  it('SSRF 拦截会记录为列表阶段错误', async () => {
    const strictRequest = createRequestClient({ timeoutMs: 5000 })
    const strictEngine = new CrawlEngine({ request: strictRequest })

    try {
      const result = await strictEngine.crawlCategory(makeContext())
      expect(result.errors[0]?.code).toBe(RequestErrorCode.BLOCKED_URL)
      expect(result.articles).toHaveLength(0)
    } finally {
      strictRequest.close()
    }
  })

  it('任务取消后不再发起新请求', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await engine.crawlCategory(makeContext(makeRule(), controller.signal))
    expect(result.errors[0]?.code).toBe(RequestErrorCode.ABORTED)
  })

  it('详情页 404 记录 HTTP_STATUS 错误', async () => {
    const context = makeContext(
      makeRule({
        detail: { fields: detailFields },
      }),
    )
    const result = await engine.parseDetail(context, { url: `${origin}/missing.html`, sourceUrl: context.url })
      .catch((error: unknown) => error)

    expect(result).toMatchObject({ code: RequestErrorCode.HTTP_STATUS })
  })
})

describe('采集引擎：浏览器模式', () => {
  it('用 Playwright 渲染 SPA 后提取字段', async () => {
    const context = makeContext(
      makeRule({
        request: { mode: 'browser', timeoutMs: 15_000 },
        detail: {
          fields: {
            title: { type: 'text', selector: '.article-title', required: true },
            content: { type: 'html', selector: '.article-content' },
          },
        },
        clean: { removeSelectors: ['.ad'] },
      }),
    )

    const result = await engine.parseDetail(context, { url: `${origin}/spa`, sourceUrl: origin })
    expect(result.article?.title).toBe('脚本渲染的标题')
    expect(result.article?.content).toContain('脚本文本')
    expect(result.article?.content).not.toContain('广告')
  }, 60_000)

  it('未启用浏览器时明确报错，不静默降级', async () => {
    const httpOnlyEngine = new CrawlEngine({ request })
    const context = makeContext(makeRule({ request: { mode: 'browser' } }))

    const error = await httpOnlyEngine.parseDetail(context, { url: `${origin}/spa`, sourceUrl: origin })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: RequestErrorCode.UNSUPPORTED })
  })
})
