/**
 * 插件上下文验收：`ctx` 必须与「本次运行」一致。
 *
 * 覆盖三件此前会静默失效的事：
 * 1. `ctx.request` 绑定本次代理（测试器里选的、栏目配置的，都要生效）；
 * 2. `ctx.mode` / `ctx.proxy` 如实反映本次运行；
 * 3. `ctx.fetchPage` 由引擎注入，browser 模式下才真的走浏览器。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CrawlContext, ProxySettings } from '../../src/shared/index.js'
import type { HttpRequestOptions, HttpResponse, RequestClient } from '../../src/request/index.js'
import type { PluginContext, PluginModule, PluginRegistry, PluginSlot } from '../../src/plugin-system/index.js'
import { createFlowPluginRunner, createParserPluginRunner } from '../../src/server/services/task-executor.js'

const PROXY: ProxySettings = { protocol: 'http', host: '127.0.0.1', port: 7890 }

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** 假请求器：记录每次调用收到的代理配置。 */
function createFakeRequest() {
  const seen: Array<{ url: string; proxy: unknown }> = []
  const response = { ok: true, status: 200, text: '<html></html>' } as HttpResponse
  const client = {
    request: async (options: HttpRequestOptions) => {
      seen.push({ url: options.url, proxy: options.proxy })
      return response
    },
    get: async (url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}) => {
      seen.push({ url, proxy: options.proxy })
      return response
    },
    post: async (url: string, _body?: unknown, options: Omit<HttpRequestOptions, 'url' | 'method' | 'body'> = {}) => {
      seen.push({ url, proxy: options.proxy })
      return response
    },
    getText: async (url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}) => {
      seen.push({ url, proxy: options.proxy })
      return ''
    },
    getJson: async <T>(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}) => {
      seen.push({ url, proxy: options.proxy })
      return {} as T
    },
  }
  return { client: client as unknown as RequestClient, seen }
}

function makeContext(overrides: Partial<CrawlContext> = {}): CrawlContext {
  return {
    site: { id: '1', name: '测试站', domain: 'example.com', baseUrl: 'https://example.com' },
    category: { id: '2', siteId: '1', name: '栏目', listUrl: 'https://example.com/list' },
    rule: { version: 1, config: { version: 1 } },
    url: 'https://example.com/list',
    requestOptions: {},
    proxy: PROXY,
    signal: new AbortController().signal,
    logger: silentLogger,
    metadata: {},
    ...overrides,
  }
}

/** 用真插件对象造注册表：flow 走 getFlow，parser 走 getParser。 */
function createRegistry(plugin: PluginModule, type: 'flow' | 'parser'): PluginRegistry {
  return {
    getFlow: (_id: string, slot: PluginSlot) =>
      type === 'flow' && (slot === 'list' ? plugin.getList : plugin.getDetail) ? plugin : null,
    getParser: (_id: string, slot: PluginSlot) =>
      type === 'parser' && (slot === 'list' ? plugin.parseList : plugin.parseDetail) ? plugin : null,
    get: () => plugin,
  } as unknown as PluginRegistry
}

describe('全流程插件的 ctx', () => {
  it('ctx.request.get 带上本次运行的代理', async () => {
    const { client, seen } = createFakeRequest()
    let captured: PluginContext | null = null

    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getList: async (_url, ctx) => {
            captured = ctx
            await ctx.request.get('https://example.com/detail')
            return []
          },
        },
        'flow',
      ),
      client,
    )

    await runner({ pluginId: 'flow', slot: 'list', url: 'https://example.com/list', context: makeContext() })

    expect(seen).toEqual([{ url: 'https://example.com/detail', proxy: PROXY }])
    expect(captured!.proxy).toEqual(PROXY)
  })

  it('ctx.mode 跟随测试器传的模式', async () => {
    const { client } = createFakeRequest()
    let captured: PluginContext | null = null

    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getList: async (_url, ctx) => {
            captured = ctx
            return []
          },
        },
        'flow',
      ),
      client,
    )

    await runner({
      pluginId: 'flow',
      slot: 'list',
      url: 'https://example.com/list',
      context: makeContext({ requestOptions: { mode: 'browser' } }),
    })

    expect(captured!.mode).toBe('browser')
  })

  it('ctx.fetchPage 使用引擎注入的抓取函数（浏览器 / 代理由引擎决定）', async () => {
    const { client } = createFakeRequest()
    const fetchPage = vi.fn(async () => ({ html: '<h1>渲染后</h1>', finalUrl: 'https://example.com/a', status: 200 }))
    let captured: PluginContext | null = null

    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getDetail: async (_url, ctx) => {
            captured = ctx
            const page = await ctx.fetchPage('https://example.com/a')
            return { title: page.html }
          },
        },
        'flow',
      ),
      client,
    )

    const result = await runner({
      pluginId: 'flow',
      slot: 'detail',
      url: 'https://example.com/a',
      context: makeContext(),
      fetchPage,
    })

    expect(fetchPage).toHaveBeenCalledWith('https://example.com/a')
    expect(result).toEqual({ title: '<h1>渲染后</h1>' })
    expect(captured!.fetchPage).toBe(fetchPage)
  })

  it('没有注入 fetchPage 时给出明确错误，而不是静默退回 HTTP', async () => {
    const { client } = createFakeRequest()
    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getList: async (_url, ctx) => {
            await ctx.fetchPage('https://example.com/a')
            return []
          },
        },
        'flow',
      ),
      client,
    )

    await expect(
      runner({ pluginId: 'flow', slot: 'list', url: 'https://example.com/list', context: makeContext() }),
    ).rejects.toThrow('fetchPage')
  })

  it('插件显式传 proxy: null 时该次请求直连', async () => {
    const { client, seen } = createFakeRequest()
    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getList: async (_url, ctx) => {
            await ctx.request.get('https://example.com/direct', { proxy: null })
            return []
          },
        },
        'flow',
      ),
      client,
    )

    await runner({ pluginId: 'flow', slot: 'list', url: 'https://example.com/list', context: makeContext() })
    expect(seen[0]?.proxy).toBeNull()
  })

  it('ctx.html2object + ctx.schema 能按 schema 解析整页', async () => {
    const { client } = createFakeRequest()
    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getDetail: async (_url, ctx) => {
            const html = `<html><body>
              <h1 class="title">标题一</h1>
              <span class="tag">A</span><span class="tag">B</span>
              <p class="missing"></p>
            </body></html>`
            const data = ctx.html2object(html, {
              title: ctx.schema.text('.title'),
              tags: ctx.schema.loop('.tag', ctx.schema.text('')),
              author: ctx.schema.nullable(ctx.schema.text('.author')),
            })
            return { title: `${data.title}|${data.tags.join(',')}`, content: String(data.author) }
          },
        },
        'flow',
      ),
      client,
    )

    const result = (await runner({
      pluginId: 'flow',
      slot: 'detail',
      url: 'https://example.com/a',
      context: makeContext(),
    })) as { title: string; content: string }

    expect(result.title).toBe('标题一|A,B')
    // nullable：未匹配返回 null 而不是空字符串
    expect(result.content).toBe('null')
  })

  it('ctx 注入本次运行的页面配置（站点 / 栏目 / 规则 / 请求配置）', async () => {
    const { client } = createFakeRequest()
    let captured: PluginContext | null = null

    const runner = createFlowPluginRunner(
      createRegistry(
        {
          config: { id: 'flow', name: 'flow', type: 'flow' },
          getList: async (_url, ctx) => {
            captured = ctx
            return []
          },
        },
        'flow',
      ),
      client,
    )

    await runner({
      pluginId: 'flow',
      slot: 'list',
      url: 'https://example.com/list',
      context: makeContext({
        rule: { version: 3, config: { version: 1, collectScope: 'full' } },
        requestOptions: { mode: 'browser', timeoutMs: 8000 },
      }),
    })

    expect(captured!.site).toEqual({ id: '1', name: '测试站', domain: 'example.com', baseUrl: 'https://example.com' })
    expect(captured!.category).toMatchObject({ id: '2', name: '栏目', listUrl: 'https://example.com/list' })
    expect(captured!.rule.version).toBe(3)
    expect(captured!.rule.config.collectScope).toBe('full')
    expect(captured!.requestOptions).toEqual({ mode: 'browser', timeoutMs: 8000 })
    // 便捷字段与快照保持一致
    expect(captured!.siteId).toBe(captured!.site.id)
    expect(captured!.categoryId).toBe(captured!.category.id)
  })
})

describe('解析器插件的 ctx', () => {
  it('同样绑定代理，并能拿到引擎注入的 fetchPage', async () => {
    const { client, seen } = createFakeRequest()
    const fetchPage = vi.fn(async () => ({ html: '<p>x</p>', finalUrl: 'https://example.com/a', status: 200 }))
    let captured: PluginContext | null = null

    const runner = createParserPluginRunner(
      createRegistry(
        {
          config: { id: 'parser', name: 'parser', type: 'parser' },
          parseDetail: async (_url, fields, ctx) => {
            captured = ctx
            await ctx.request.get('https://example.com/raw')
            await ctx.fetchPage('https://example.com/a')
            return { ...fields, fixed: true }
          },
        },
        'parser',
      ),
      client,
    )

    const result = await runner(
      { title: '原标题' },
      makeContext({
        requestOptions: { mode: 'browser' },
        rule: { version: 1, config: { version: 1, parserPlugins: ['parser'] } },
      }),
      {
        html: '<html></html>',
        url: 'https://example.com/a',
        stage: 'detail',
        fetchPage,
      },
    )

    expect(result).toEqual({ title: '原标题', fixed: true })
    expect(seen[0]?.proxy).toEqual(PROXY)
    expect(captured!.mode).toBe('browser')
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
})
