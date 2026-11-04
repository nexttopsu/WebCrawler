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
import type { PluginContext, PluginRegistry, PluginSlot } from '../../src/plugin-system/index.js'
import { createFlowPluginRunner, createParserPluginRunner } from '../../src/server/services/task-executor.js'

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
    // 最小注册表桩：任何名字都返回一个会记录调用的解析器插件（两个阶段都实现）
    const transform = (stage: 'list' | 'detail') => async (_url: string, fields: Record<string, unknown>) => {
      calls.push({ name: stage === 'list' ? 'list-decrypt' : 'detail-decrypt', stage })
      return { ...fields, title: `[${stage}] ${String(fields.title ?? '')}` }
    }
    const registry = {
      getParser: (id: string) => ({
        config: { id, name: id, type: 'parser' },
        source: `src/plugins/${id}.ts`,
        parseList: transform('list'),
        parseDetail: transform('detail'),
      }),
      get: (id: string) => ({ config: { id, name: id, type: 'parser' }, source: `src/plugins/${id}.ts` }),
    } as unknown as PluginRegistry
    const pluginEngine = new CrawlEngine({
      request,
      browser,
      parserPluginRunner: createParserPluginRunner(registry, request),
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

describe('采集引擎：全流程插件', () => {
  /** 造一个全流程插件注册表桩；`functions` 控制导出哪几个函数。 */
  function flowRegistry(functions: { list?: unknown; detail?: unknown }): PluginRegistry {
    return {
      getFlow: (id: string, slot: PluginSlot) => ({
        config: { id, name: id, type: 'flow' },
        source: `src/plugins/${id}.ts`,
        ...(functions.list === undefined ? {} : { getList: functions.list }),
        ...(functions.detail === undefined ? {} : { getDetail: functions.detail }),
        // 阶段不匹配时由运行器报错，这里保证只返回实现了该阶段的插件
        ...(slot === 'list' && functions.list === undefined ? { getList: undefined } : {}),
      }),
      get: (id: string) => ({ config: { id, name: id, type: 'flow' }, source: `src/plugins/${id}.ts` }),
    } as unknown as PluginRegistry
  }

  function pluginEngine(registry: PluginRegistry): CrawlEngine {
    return new CrawlEngine({ request, browser, flowPluginRunner: createFlowPluginRunner(registry, request) })
  }

  it('ctx.fetchPage 在 browser 模式下返回执行过 JS 的页面', async () => {
    const registry = flowRegistry({
      list: async (_url: string, ctx: PluginContext) => {
        // /spa 的正文由内联脚本写入，HTTP 抓到的只是空壳
        const page = await ctx.fetchPage(`${origin}/spa`)
        const rendered = page.html.includes('脚本渲染的标题')
        return [{ url: `${origin}/news/1.html`, title: rendered ? '渲染成功' : '未渲染', extra: { status: page.status } }]
      },
    })
    const context = makeContext(makeRule({ list: { plugin: 'demo-flow' } }))
    context.requestOptions = { mode: 'browser' }

    const page = await pluginEngine(registry).listPage(context)
    expect(page.links[0]?.title).toBe('渲染成功')
    expect(page.links[0]?.metadata).toEqual({ status: 200 })
  })

  it('列表阶段由 getList 返回条目，引擎负责补绝对地址、去重与字段映射', async () => {
    const registry = flowRegistry({
      list: async () => [
        { url: '/news/1.html', title: ' 一篇 ', author: '张三', articleTime: '2026-01-01', coverUrl: '/cover.jpg' },
        { url: '/news/1.html' },
        { url: 'javascript:void(0)' },
        { title: '没有地址' },
        { url: '/news/2.html', extra: { source: 'plugin' } },
      ],
      detail: async () => ({ title: 'x' }),
    })
    const context = makeContext(makeRule({ list: { plugin: 'demo-flow' } }))
    const page = await pluginEngine(registry).listPage(context)

    expect(page.links.map((link) => link.url)).toEqual([`${origin}/news/1.html`, `${origin}/news/2.html`])
    expect(page.links[0]).toMatchObject({
      title: '一篇',
      author: '张三',
      articleTime: '2026-01-01',
      coverUrl: `${origin}/cover.jpg`,
      sourceUrl: `${origin}/list`,
    })
    expect(page.links[1]?.metadata).toEqual({ source: 'plugin' })
    // 重复 / 伪协议 / 缺地址各算一次
    expect(page.duplicateCount).toBe(3)
    expect(page.itemCount).toBe(5)
    // 插件自己发请求，状态码由插件决定
    expect(page.status).toBe(0)
  })

  it('getList 返回非数组时明确报错', async () => {
    const registry = flowRegistry({ list: async () => ({ list: [] }), detail: async () => ({}) })
    const error = await pluginEngine(registry)
      .listPage(makeContext(makeRule({ list: { plugin: 'demo-flow' } })))
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'INVALID_FIELD_RULE' })
    expect((error as Error).message).toContain('必须返回数组')
  })

  it('插件没导出 getList 时报错并说明它的实际能力', async () => {
    const registry = flowRegistry({ detail: async () => ({ title: 'x' }) })
    const error = await pluginEngine(registry)
      .listPage(makeContext(makeRule({ list: { plugin: 'demo-flow' } })))
      .catch((e: unknown) => e)

    expect((error as Error).message).toContain('getList')
  })

  it('运行环境没有插件运行器时报错，不静默走默认流程', async () => {
    const error = await engine
      .listPage(makeContext(makeRule({ list: { plugin: 'demo-flow' } })))
      .catch((e: unknown) => e)

    expect((error as Error).message).toContain('没有加载插件')
  })

  it('详情阶段由 getDetail 返回文章，url 始终取列表链接', async () => {
    const registry = flowRegistry({
      detail: async () => ({
        url: '/news/999.html',
        title: '插件给的标题',
        author: '李四',
        articleTime: '2026-02-02',
        content: '<p>正文</p>',
        coverUrl: '/cover-2.jpg',
        extra: { tag: 'x' },
      }),
    })
    const context = makeContext(makeRule({ detail: { plugin: 'demo-flow' } }))
    const result = await pluginEngine(registry).parseDetail(context, {
      url: `${origin}/news/1.html`,
      sourceUrl: context.url,
    })

    expect(result.article).toMatchObject({
      title: '插件给的标题',
      author: '李四',
      articleTime: '2026-02-02',
      content: '<p>正文</p>',
      coverUrl: `${origin}/cover-2.jpg`,
      // 插件返回的规范地址不覆盖列表链接，否则同 URL 去重会失效
      url: `${origin}/news/1.html`,
    })
    expect(result.article?.metadata).toMatchObject({ sourceUrl: `${origin}/list`, tag: 'x' })
  })

  it('详情插件没返回标题时该篇按失败处理（article 为空）', async () => {
    const registry = flowRegistry({ detail: async () => ({ author: '李四' }) })
    const context = makeContext(makeRule({ detail: { plugin: 'demo-flow' } }))
    const result = await pluginEngine(registry).parseDetail(context, {
      url: `${origin}/news/1.html`,
      sourceUrl: context.url,
    })

    expect(result.article).toBeNull()
    expect(result.errors).toEqual(['缺少标题'])
  })

  it('crawlCategory 走插件后能拿到链接与文章', async () => {
    const registry = flowRegistry({
      list: async () => [{ url: `${origin}/news/1.html`, title: '列表标题' }, { url: `${origin}/news/3.html` }],
      detail: async (url: string) => ({ title: `详情 ${url.split('/').pop()}`, content: '<p>正文</p>' }),
    })
    const context = makeContext(makeRule({ list: { plugin: 'demo-flow' }, detail: { plugin: 'demo-flow' } }))
    const result = await pluginEngine(registry).crawlCategory(context)

    expect(result.stats.linkCount).toBe(2)
    expect(result.articles.map((article) => article.title)).toEqual(['详情 1.html', '详情 3.html'])
    expect(result.errors).toEqual([])
  })
})
