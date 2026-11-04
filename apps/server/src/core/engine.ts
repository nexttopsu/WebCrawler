/**
 * 采集引擎。
 *
 * 职责：按规则取页面 → 提取列表链接 → 逐篇提取详情 → 交给管道产出 `ArticleData`。
 * 只依赖统一请求层与解析器，不依赖 H3、不依赖数据库，也不绑定任务调度。
 *
 * 单篇失败不会中断整批采集，错误按 URL 收集，供上层写 `crawl_error`。
 */
import type { ArticleData, ArticleLink, CrawlContext, FieldRule, ListRuleConfig, RequestMode } from '../shared/index.js'
import { RequestError, RequestErrorCode, type BrowserClient, type RequestClient } from '../request/index.js'
import { ParserError } from './errors.js'
import { Parser, createParser } from './parser/index.js'
import { extractListItems, stripElements } from './parser/html2object-bridge.js'
import { runPipeline, type PipelineResult } from './pipeline.js'
import { getDocumentBase, resolveUrl } from './url.js'

/** 引擎可用的服务。 */
export interface CrawlServices {
  request: RequestClient
  parser: Parser
  /** 未配置浏览器时，browser 模式会明确报错，而不是静默降级 */
  browser: BrowserClient | null
}

/**
 * 解析器插件执行器：按规则 `parserPlugins` 顺序对提取结果做重格式化。
 * 由应用层实现（从插件注册表解析插件链），引擎只负责在正确时机调用。
 * `stage` 标记执行阶段：list = 列表字段提取后，detail = 详情字段提取后。
 * `fetchPage` 供插件按需补抓页面（与引擎同一条代理 / 浏览器路径）。
 */
export type ParserPluginRunner = (
  data: Record<string, unknown>,
  context: CrawlContext,
  source: { html: string; url: string; stage: 'list' | 'detail'; fetchPage?: PluginFetchPage },
) => Promise<Record<string, unknown>>

/**
 * 全流程插件执行器。
 *
 * - `slot=list`：入参是分页后的完整地址，返回该页的条目数组；
 * - `slot=detail`：入参是文章地址，返回一篇文章的字段对象。
 *
 * 返回结构由执行器侧校验（数组 / 对象），引擎只负责把结果映射成链接或文章。
 */
export type FlowPluginRunner = (input: {
  pluginId: string
  slot: 'list' | 'detail'
  url: string
  context: CrawlContext
  /** 插件上下文里的 `ctx.fetchPage`：由引擎注入，保证浏览器模式与代理对插件同样生效 */
  fetchPage?: PluginFetchPage
}) => Promise<unknown>

/** 创建引擎的配置。 */
export interface CrawlEngineOptions {
  request: RequestClient
  parser?: Parser
  browser?: BrowserClient | null
  /** 解析器插件执行器；规则未配置 parserPlugins 时不会被调用 */
  parserPluginRunner?: ParserPluginRunner
  /** 全流程插件执行器；规则未配置 list.plugin / detail.plugin 时不会被调用 */
  flowPluginRunner?: FlowPluginRunner
}

/** 一次页面抓取的结果。 */
export interface FetchedPage {
  html: string
  finalUrl: string
  status: number
  mode: RequestMode
  elapsedMs: number
}

/** 给插件用的抓取结果：不暴露 mode / elapsedMs，避免插件依赖内部字段。 */
export interface FetchedPageView {
  html: string
  finalUrl: string
  status: number
}

/** 插件可用的抓取能力（`ctx.fetchPage`）。 */
export type PluginFetchPage = (url: string) => Promise<FetchedPageView>

/**
 * 解析一次运行使用的请求模式。
 *
 * 顺序：调用方显式指定（测试器传的 mode）> 规则里的 request.mode > 规则的 browser.enabled > HTTP。
 * 抽成纯函数，是为了让插件上下文和引擎拿到同一个结论，不要各算一套。
 */
export function resolveRequestMode(context: CrawlContext): RequestMode {
  if (context.requestOptions.mode) return context.requestOptions.mode
  if (context.rule.config.request?.mode) return context.rule.config.request.mode
  if (context.rule.config.browser?.enabled) return 'browser'
  return 'http'
}

/** 列表页解析结果：链接 + 列表项命中数量 + 页面元信息。 */
export interface ListPageResult {
  links: ArticleLink[]
  /** itemSelector 命中的节点数（可能大于链接数：无链接或重复链接会被过滤） */
  itemCount: number
  /** 因重复或非 http(s) 地址被丢弃的链接数，规则测试器用于「检查重复链接」 */
  duplicateCount: number
  finalUrl: string
  status: number
  mode: RequestMode
  elapsedMs: number
}

/** 采集过程中的错误记录。 */
export interface CrawlErrorRecord {
  url: string
  stage: 'list' | 'detail'
  code: string
  message: string
}

/** 单个栏目的采集结果。 */
export interface CategoryCrawlResult {
  links: ArticleLink[]
  articles: ArticleData[]
  results: PipelineResult[]
  errors: CrawlErrorRecord[]
  stats: {
    linkCount: number
    articleCount: number
    failedCount: number
    elapsedMs: number
  }
}

/** 引擎执行选项。 */
export interface CrawlRunOptions {
  /** 最多处理多少篇，默认不限制 */
  limit?: number
  /** 仅抓列表，不抓详情 */
  listOnly?: boolean
}

function errorCode(error: unknown): string {
  if (error instanceof RequestError) return error.code
  if (error instanceof ParserError) return error.code
  return 'UNKNOWN'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 插件返回值里的文本字段：只接受字符串与数字，其它一律视为空。 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 采集引擎。 */
export class CrawlEngine {
  readonly services: CrawlServices
  private readonly parserPluginRunner: ParserPluginRunner | null
  private readonly flowPluginRunner: FlowPluginRunner | null

  constructor(options: CrawlEngineOptions) {
    this.services = {
      request: options.request,
      parser: options.parser ?? createParser(),
      browser: options.browser ?? null,
    }
    this.parserPluginRunner = options.parserPluginRunner ?? null
    this.flowPluginRunner = options.flowPluginRunner ?? null
  }

  /** 解析本次请求使用的模式。 */
  resolveMode(context: CrawlContext): RequestMode {
    return resolveRequestMode(context)
  }

  /**
   * 提供给插件的抓取能力。
   *
   * 走的是引擎自己的 `fetchPage`，所以 browser 模式、代理、SSRF、超时全部一致——
   * 插件不需要（也不允许）自己 launch 浏览器。
   */
  private pluginFetchPage(context: CrawlContext): PluginFetchPage {
    return async (url) => {
      const page = await this.fetchPage(context, url)
      return { html: page.html, finalUrl: page.finalUrl, status: page.status }
    }
  }

  /** 抓取页面：按规则决定走 HTTP 还是浏览器渲染。 */
  async fetchPage(context: CrawlContext, url: string = context.url): Promise<FetchedPage> {
    if (context.signal.aborted) {
      throw new RequestError(RequestErrorCode.ABORTED, '任务已取消', { url })
    }

    const mode = this.resolveMode(context)
    const startedAt = performance.now()
    const timeoutMs =
      context.requestOptions.timeoutMs ?? context.rule.config.request?.timeoutMs ?? 15_000

    if (mode === 'browser') {
      const browser = this.services.browser
      if (!browser) {
        throw new RequestError(RequestErrorCode.UNSUPPORTED, '当前未启用浏览器，无法使用 browser 模式', {
          url,
          retryable: false,
        })
      }
      const ruleBrowser = context.rule.config.browser
      const page = await browser.fetchPage({
        url,
        proxy: context.proxy,
        timeoutMs: ruleBrowser?.timeoutMs ?? timeoutMs,
        waitUntil: context.requestOptions.waitUntil ?? ruleBrowser?.waitUntil ?? 'load',
        waitForSelector: context.requestOptions.waitForSelector ?? ruleBrowser?.waitForSelector,
        blockResources: context.requestOptions.blockResources ?? ruleBrowser?.blockResources ?? false,
        userAgent: context.requestOptions.userAgent ?? ruleBrowser?.userAgent,
        viewport: ruleBrowser?.viewport,
        signal: context.signal,
      })
      return {
        html: page.html,
        finalUrl: page.finalUrl,
        status: page.status,
        mode,
        elapsedMs: Math.round(performance.now() - startedAt),
      }
    }

    const ruleRequest = context.rule.config.request
    const response = await this.services.request.get(url, {
      headers: { ...ruleRequest?.headers, ...context.requestOptions.headers },
      query: context.requestOptions.query,
      timeoutMs,
      retries: context.requestOptions.retries ?? ruleRequest?.retries ?? 0,
      maxBytes: context.requestOptions.maxBytes ?? ruleRequest?.maxBytes,
      maxRedirects: context.requestOptions.maxRedirects ?? ruleRequest?.maxRedirects,
      userAgent: context.requestOptions.userAgent ?? ruleRequest?.userAgent,
      encoding: context.requestOptions.encoding ?? ruleRequest?.encoding,
      cookies: context.requestOptions.cookies ?? ruleRequest?.cookies,
      proxy: context.proxy,
      signal: context.signal,
    })

    if (!response.ok) {
      throw new RequestError(RequestErrorCode.HTTP_STATUS, `请求失败：HTTP ${response.status}`, {
        url,
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      })
    }

    return {
      html: response.text,
      finalUrl: response.finalUrl,
      status: response.status,
      mode,
      elapsedMs: response.elapsedMs,
    }
  }

  /**
   * 抓取列表页并提取文章链接。
   *
   * 同时返回列表项命中数量与页面元信息：规则测试器需要这些数据判断
   * 「选择器是否命中了结构」，而正式采集只用 `links`。
   */
  async listPage(context: CrawlContext): Promise<ListPageResult> {
    const listRule = context.rule.config.list
    if (listRule?.plugin) {
      return this.listPageWithPlugin(listRule, context)
    }
    if (!listRule?.itemSelector) {
      throw new ParserError(
        'INVALID_FIELD_RULE',
        '规则缺少 list.itemSelector，无法提取列表链接',
      )
    }

    const listUrl = listRule.url ?? context.category.listUrl ?? context.url
    const page = await this.fetchPage(context, listUrl)
    // 排除选择器优先级最高：字段提取前先删除命中的节点（混淆 / 广告等）
    const html = stripElements(page.html, listRule.excludeSelectors ?? [])
    const base = getDocumentBase(html, page.finalUrl)
    const parser = this.services.parser

    // 字段配置路径：html2object loop 一次解析全部列表项
    if (listRule.fields) {
      return await this.listPageWithFields(listRule, context, page, html, base)
    }

    const doc = this.services.parser.parseHtml(html)

    const items = doc.selectAll(listRule.itemSelector)
    const links: ArticleLink[] = []
    const seen = new Set<string>()
    let duplicateCount = 0

    for (const item of items) {
      const linkSelector = listRule.linkSelector ?? 'a'
      const linkNodes = linkSelector ? item.findAll(linkSelector) : [item]
      const linkNode = linkNodes[0]
      if (!linkNode) continue

      const rawHref = linkNode.attr(listRule.linkAttribute ?? 'href')
      if (!rawHref || /^(javascript|mailto|tel):/i.test(rawHref.trim())) continue

      const absolute = parser.normalizeUrl(resolveUrl(rawHref, base))
      if (!/^https?:\/\//i.test(absolute)) {
        duplicateCount += 1
        continue
      }
      if (seen.has(absolute)) {
        duplicateCount += 1
        continue
      }
      seen.add(absolute)

      const titleNode = listRule.titleSelector
        ? item.findAll(listRule.titleSelector)[0]
        : linkNode
      const title = parser.cleanText(titleNode?.text() ?? '')

      const link: ArticleLink = { url: absolute, sourceUrl: page.finalUrl }
      if (title) link.title = title

      // 封面图：列表阶段提取（详情页没有封面时的兜底来源）
      if (listRule.coverSelector) {
        const coverNode = item.findAll(listRule.coverSelector)[0]
        const rawCover = coverNode?.attr(listRule.coverAttribute ?? 'src')?.trim()
        if (rawCover) {
          const coverAbsolute = parser.normalizeUrl(resolveUrl(rawCover, base))
          if (/^https?:\/\//i.test(coverAbsolute)) link.coverUrl = coverAbsolute
        }
      }

      links.push(link)
    }

    return {
      links,
      itemCount: items.length,
      duplicateCount,
      finalUrl: page.finalUrl,
      status: page.status,
      mode: page.mode,
      elapsedMs: page.elapsedMs,
    }
  }

  /**
   * 列表插件路径：插件拿到分页后的完整地址，返回这一页的条目。
   *
   * 平台只做三件事：把相对地址补成绝对地址、丢弃重复/非法条目、
   * 把作者 / 摘要 / 正文 / 封面 / 文章时间等内置字段挂到链接上。
   */
  private async listPageWithPlugin(listRule: ListRuleConfig, context: CrawlContext): Promise<ListPageResult> {
    const pluginId = listRule.plugin ?? ''
    if (!this.flowPluginRunner) {
      throw new ParserError('INVALID_FIELD_RULE', `规则使用了列表插件 "${pluginId}"，但当前运行环境没有加载插件`)
    }

    const url = listRule.url ?? context.category.listUrl ?? context.url
    const startedAt = performance.now()
    const raw = await this.flowPluginRunner({ pluginId, slot: 'list', url, context, fetchPage: this.pluginFetchPage(context) })
    if (!Array.isArray(raw)) {
      throw new ParserError(
        'INVALID_FIELD_RULE',
        `列表插件 "${pluginId}" 必须返回数组，每项至少包含 url（实际返回 ${typeof raw}）`,
      )
    }

    const parser = this.services.parser
    const links: ArticleLink[] = []
    const seen = new Set<string>()
    let duplicateCount = 0

    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        duplicateCount += 1
        continue
      }
      const record = item as Record<string, unknown>
      const rawUrl = asText(record.url)
      if (!rawUrl) {
        duplicateCount += 1
        continue
      }

      let absolute = ''
      try {
        absolute = parser.normalizeUrl(resolveUrl(rawUrl, url))
      } catch {
        absolute = ''
      }
      if (!/^https?:\/\//i.test(absolute) || seen.has(absolute)) {
        duplicateCount += 1
        continue
      }
      seen.add(absolute)

      const link: ArticleLink = { url: absolute, sourceUrl: url }
      const title = asText(record.title)
      if (title) link.title = title
      const author = asText(record.author)
      if (author) link.author = author
      const summary = asText(record.summary)
      if (summary) link.summary = summary
      const content = asText(record.content)
      if (content) link.content = content
      const articleTime = asText(record.articleTime)
      if (articleTime) link.articleTime = articleTime

      const coverRaw = asText(record.coverUrl)
      if (coverRaw) {
        try {
          const cover = parser.normalizeUrl(resolveUrl(coverRaw, url))
          if (/^https?:\/\//i.test(cover)) link.coverUrl = cover
        } catch {
          // 封面地址非法时忽略，不影响条目入库
        }
      }

      if (record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)) {
        link.metadata = { ...(record.extra as Record<string, unknown>) }
      }

      links.push(link)
    }

    return {
      links,
      itemCount: raw.length,
      duplicateCount,
      finalUrl: url,
      // 插件自己发请求，状态码不在平台侧，0 表示「由插件决定」
      status: 0,
      mode: this.resolveMode(context),
      elapsedMs: Math.round(performance.now() - startedAt),
    }
  }

  /**
   * 字段配置路径的列表提取：title / url 必填，其余字段进 metadata。
   *
   * 规则配置了 `parserPlugins` 时，每个列表项在提取完成后都会过一遍插件链
   * （stage = 'list'），插件可用于修正列表阶段的自定义字段；插件抛错时
   * 该条按「重复/非法链接」计数并记录警告，不中断整页提取。
   */
  private async listPageWithFields(
    listRule: ListRuleConfig,
    context: CrawlContext,
    page: FetchedPage,
    html: string,
    base: string,
  ): Promise<ListPageResult> {
    const fields = listRule.fields ?? {}
    // html 已由调用方应用排除选择器（提取前删除混淆节点）
    // 调用方已保证有 itemSelector（缺了会在 listPage 直接报错）
    const items = extractListItems(html, listRule.itemSelector ?? '', fields)
    const parser = this.services.parser

    // 列表阶段只用 list.parserPlugins（与详情阶段的顶层 parserPlugins 互不影响）
    const pluginNames = listRule.parserPlugins ?? []
    const usePlugins = Boolean(this.parserPluginRunner && pluginNames.length > 0)

    const links: ArticleLink[] = []
    const seen = new Set<string>()
    let duplicateCount = 0

    for (const rawItem of items) {
      let item = rawItem
      if (usePlugins) {
        try {
          item = await this.parserPluginRunner!(rawItem, context, {
            html: page.html,
            url: page.finalUrl,
            stage: 'list',
            fetchPage: this.pluginFetchPage(context),
          })
        } catch (error) {
          context.logger.warn(
            `列表解析器插件执行失败，该条已跳过：${error instanceof Error ? error.message : String(error)}`,
          )
          duplicateCount += 1
          continue
        }
      }

      const rawUrl = typeof item.url === 'string' ? item.url.trim() : ''
      if (!rawUrl || /^(javascript|mailto|tel):/i.test(rawUrl)) {
        duplicateCount += 1
        continue
      }
      const absolute = parser.normalizeUrl(resolveUrl(rawUrl, base))
      if (!/^https?:\/\//i.test(absolute)) {
        duplicateCount += 1
        continue
      }
      if (seen.has(absolute)) {
        duplicateCount += 1
        continue
      }
      seen.add(absolute)

      const link: ArticleLink = { url: absolute, sourceUrl: page.finalUrl }
      const title = typeof item.title === 'string' ? parser.cleanText(item.title) : ''
      if (title) link.title = title

      const coverRaw = [item.coverUrl, item.cover].find(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
      if (coverRaw) {
        const coverAbsolute = parser.normalizeUrl(resolveUrl(coverRaw.trim(), base))
        if (/^https?:\/\//i.test(coverAbsolute)) link.coverUrl = coverAbsolute
      }

      // 统一内置字段：列表阶段提取到的作者 / 摘要 / 正文 / 文章时间直接入对应列，
      // 详情阶段未提取时保留列表值（见 saveListArticle 与 mergeDetailFields 的合并逻辑）
      const builtInText = (key: string): string => {
        const value = item[key]
        return typeof value === 'string' && value.trim() !== '' ? parser.cleanText(value) : ''
      }
      const listAuthor = builtInText('author')
      if (listAuthor) link.author = listAuthor
      const listSummary = builtInText('summary')
      if (listSummary) link.summary = listSummary
      const listContent = builtInText('content')
      if (listContent) link.content = listContent
      const listArticleTime = builtInText('articleTime') || builtInText('publishTime')
      if (listArticleTime) link.articleTime = listArticleTime

      // 其余自定义字段随链接带入 metadata，列表任务入库时写入 extra
      const metadata: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(item)) {
        if (
          key === 'title' ||
          key === 'url' ||
          key === 'cover' ||
          key === 'coverUrl' ||
          key === 'author' ||
          key === 'summary' ||
          key === 'content' ||
          key === 'articleTime' ||
          key === 'publishTime'
        )
          continue
        if (value === null || value === undefined || value === '') continue
        metadata[key] = value
      }
      if (Object.keys(metadata).length > 0) link.metadata = metadata

      links.push(link)
    }

    return {
      links,
      itemCount: items.length,
      duplicateCount,
      finalUrl: page.finalUrl,
      status: page.status,
      mode: page.mode,
      elapsedMs: page.elapsedMs,
    }
  }

  /** 提取列表页中的文章链接（正式采集使用的精简结果）。 */
  async listLinks(context: CrawlContext): Promise<ArticleLink[]> {
    return (await this.listPage(context)).links
  }

  /** 提取单篇文章详情。 */
  async parseDetail(context: CrawlContext, link: ArticleLink): Promise<PipelineResult> {
    return (await this.fetchAndParse(context, link)).result
  }

  /**
   * 抓取并解析详情页。
   *
   * 比 `parseDetail` 多返回原始页面：任务执行器需要把原始 HTML 一并入库，
   * 供管理后台「原始数据」查看。抓取只发生一次。
   */
  async fetchAndParse(
    context: CrawlContext,
    link: ArticleLink,
  ): Promise<{ result: PipelineResult; page: FetchedPage }> {
    const detailPlugin = context.rule.config.detail?.plugin
    if (detailPlugin) {
      return this.fetchAndParseWithPlugin(context, link, detailPlugin)
    }

    const page = await this.fetchPage(context, link.url)
    const fields: Record<string, FieldRule> = context.rule.config.detail?.fields ?? context.rule.config.fields ?? {}
    if (Object.keys(fields).length === 0) {
      throw new ParserError('INVALID_FIELD_RULE', '规则缺少 detail.fields，无法提取详情字段')
    }

    // 排除选择器优先级最高：字段提取前先删除命中的节点（混淆 / 广告等）
    const body = stripElements(page.html, context.rule.config.excludeSelectors ?? [])

    // 解析器插件链：规则配置了 parserPlugins 且运行时提供执行器时才启用
    const pluginNames = context.rule.config.parserPlugins ?? []
    const transform =
      this.parserPluginRunner && pluginNames.length > 0
        ? (data: Record<string, unknown>) =>
            this.parserPluginRunner!(data, context, {
              html: page.html,
              url: page.finalUrl,
              stage: 'detail',
              fetchPage: this.pluginFetchPage(context),
            })
        : undefined

    const result = await runPipeline(
      {
        siteId: context.site.id,
        categoryId: context.category.id,
        url: page.finalUrl,
        body,
        fields,
        clean: context.rule.config.clean,
        validate: context.rule.config.validate,
        listCoverUrl: link.coverUrl,
        metadata: {
          sourceUrl: link.sourceUrl,
          ...(link.title ? { listTitle: link.title } : {}),
          ...(link.metadata ?? {}),
        },
        ...(transform ? { transform } : {}),
      },
      this.services.parser,
    )
    return { result, page }
  }

  /**
   * 详情插件路径：插件自己抓取并解析页面，返回文章字段。
   *
   * 平台不再跑规则抽取，但仍做两件事：标题非空校验、URL 与封面地址归一化。
   * 返回的 `page.html` 为空串——插件不把原始 HTML 交给平台，原始数据页签会显示为空。
   */
  private async fetchAndParseWithPlugin(
    context: CrawlContext,
    link: ArticleLink,
    pluginId: string,
  ): Promise<{ result: PipelineResult; page: FetchedPage }> {
    if (!this.flowPluginRunner) {
      throw new ParserError('INVALID_FIELD_RULE', `规则使用了详情插件 "${pluginId}"，但当前运行环境没有加载插件`)
    }

    const startedAt = performance.now()
    const raw = await this.flowPluginRunner({ pluginId, slot: 'detail', url: link.url, context, fetchPage: this.pluginFetchPage(context) })
    const elapsedMs = Math.round(performance.now() - startedAt)

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ParserError(
        'INVALID_FIELD_RULE',
        `详情插件 "${pluginId}" 必须返回字段对象（实际返回 ${Array.isArray(raw) ? 'array' : typeof raw}）`,
      )
    }

    const article = this.articleFromPlugin(raw as Record<string, unknown>, link, context)
    const errors = article ? [] : ['缺少标题']

    return {
      result: {
        article,
        fields: {},
        missing: [],
        errors,
        steps: [
          {
            stage: 'output',
            ok: article !== null,
            durationMs: elapsedMs,
            detail: article ? `详情插件 ${pluginId}` : `详情插件 ${pluginId} 未返回标题`,
          },
        ],
      },
      page: {
        html: '',
        finalUrl: link.url,
        status: 0,
        mode: this.resolveMode(context),
        elapsedMs,
      },
    }
  }

  /** 详情插件返回值 → ArticleData；标题为空时返回 null（与管道的校验一致）。 */
  private articleFromPlugin(
    record: Record<string, unknown>,
    link: ArticleLink,
    context: CrawlContext,
  ): ArticleData | null {
    const title = asText(record.title)
    if (!title) return null

    // 地址始终用列表链接：插件返回的规范地址只作参考，覆盖会让同 URL 去重失效
    const article: ArticleData = {
      siteId: context.site.id,
      categoryId: context.category.id,
      title,
      url: link.url,
    }

    const author = asText(record.author)
    if (author) article.author = author
    const summary = asText(record.summary)
    if (summary) article.summary = summary
    const content = asText(record.content)
    if (content) article.content = content
    const articleTime = asText(record.articleTime)
    if (articleTime) article.articleTime = articleTime

    const coverRaw = asText(record.coverUrl)
    if (coverRaw) {
      try {
        const cover = this.services.parser.normalizeUrl(resolveUrl(coverRaw, link.url))
        if (/^https?:\/\//i.test(cover)) article.coverUrl = cover
      } catch {
        // 封面地址非法时留空
      }
    }

    const metadata: Record<string, unknown> = { sourceUrl: link.sourceUrl }
    if (link.title) metadata.listTitle = link.title
    if (record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)) {
      Object.assign(metadata, record.extra as Record<string, unknown>)
    }
    article.metadata = metadata

    return article
  }

  /** 采集一个栏目：列表 → 逐篇详情。 */
  async crawlCategory(context: CrawlContext, options: CrawlRunOptions = {}): Promise<CategoryCrawlResult> {
    const startedAt = performance.now()
    const errors: CrawlErrorRecord[] = []
    const articles: ArticleData[] = []
    const results: PipelineResult[] = []

    let links: ArticleLink[] = []
    try {
      links = await this.listLinks(context)
    } catch (error) {
      errors.push({
        url: context.url,
        stage: 'list',
        code: errorCode(error),
        message: errorMessage(error),
      })
      return {
        links,
        articles,
        results,
        errors,
        stats: {
          linkCount: 0,
          articleCount: 0,
          failedCount: 1,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      }
    }

    if (options.listOnly) {
      return {
        links,
        articles,
        results,
        errors,
        stats: {
          linkCount: links.length,
          articleCount: 0,
          failedCount: 0,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      }
    }

    const targets = options.limit ? links.slice(0, options.limit) : links

    for (const link of targets) {
      if (context.signal.aborted) {
        errors.push({ url: link.url, stage: 'detail', code: RequestErrorCode.ABORTED, message: '任务已取消' })
        break
      }
      try {
        const result = await this.parseDetail(context, link)
        results.push(result)
        if (result.article) {
          articles.push(result.article)
        } else {
          errors.push({
            url: link.url,
            stage: 'detail',
            code: 'VALIDATION_FAILED',
            message: result.errors.join('；') || '数据校验未通过',
          })
        }
      } catch (error) {
        errors.push({
          url: link.url,
          stage: 'detail',
          code: errorCode(error),
          message: errorMessage(error),
        })
      }
    }

    return {
      links,
      articles,
      results,
      errors,
      stats: {
        linkCount: links.length,
        articleCount: articles.length,
        failedCount: errors.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    }
  }
}

/** 创建采集引擎。 */
export function createCrawlEngine(options: CrawlEngineOptions): CrawlEngine {
  return new CrawlEngine(options)
}
