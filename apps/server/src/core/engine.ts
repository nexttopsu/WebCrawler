/**
 * 采集引擎。
 *
 * 职责：按规则取页面 → 提取列表链接 → 逐篇提取详情 → 交给管道产出 `ArticleData`。
 * 只依赖统一请求层与解析器，不依赖 H3、不依赖数据库，也不绑定任务调度。
 *
 * 单篇失败不会中断整批采集，错误按 URL 收集，供上层写 `crawl_error`。
 */
import type { ArticleData, ArticleLink, CrawlContext, FieldRule, RequestMode } from '../shared/index.js'
import { RequestError, RequestErrorCode, type BrowserClient, type RequestClient } from '../request/index.js'
import { ParserError } from './errors.js'
import { Parser, createParser } from './parser/index.js'
import { runPipeline, type PipelineResult } from './pipeline.js'
import { getDocumentBase, resolveUrl } from './url.js'

/** 引擎可用的服务。 */
export interface CrawlServices {
  request: RequestClient
  parser: Parser
  /** 未配置浏览器时，browser 模式会明确报错，而不是静默降级 */
  browser: BrowserClient | null
}

/** 创建引擎的配置。 */
export interface CrawlEngineOptions {
  request: RequestClient
  parser?: Parser
  browser?: BrowserClient | null
}

/** 一次页面抓取的结果。 */
export interface FetchedPage {
  html: string
  finalUrl: string
  status: number
  mode: RequestMode
  elapsedMs: number
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

/** 采集引擎。 */
export class CrawlEngine {
  readonly services: CrawlServices

  constructor(options: CrawlEngineOptions) {
    this.services = {
      request: options.request,
      parser: options.parser ?? createParser(),
      browser: options.browser ?? null,
    }
  }

  /** 解析本次请求使用的模式。 */
  resolveMode(context: CrawlContext): RequestMode {
    if (context.requestOptions.mode) return context.requestOptions.mode
    if (context.rule.config.request?.mode) return context.rule.config.request.mode
    if (context.rule.config.browser?.enabled) return 'browser'
    return 'http'
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
    if (!listRule?.itemSelector) {
      throw new ParserError(
        'INVALID_FIELD_RULE',
        '规则缺少 list.itemSelector，无法提取列表链接',
      )
    }

    const listUrl = listRule.url ?? context.category.listUrl ?? context.url
    const page = await this.fetchPage(context, listUrl)
    const doc = this.services.parser.parseHtml(page.html)
    const base = getDocumentBase(page.html, page.finalUrl)
    const parser = this.services.parser

    const items = doc.selectAll(listRule.itemSelector, listRule.itemSelectorType ?? 'css')
    const links: ArticleLink[] = []
    const seen = new Set<string>()
    let duplicateCount = 0

    for (const item of items) {
      const linkSelector = listRule.linkSelector ?? 'a'
      const linkNodes = linkSelector ? item.findAll(linkSelector, listRule.itemSelectorType ?? 'css') : [item]
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
        ? item.findAll(listRule.titleSelector, listRule.itemSelectorType ?? 'css')[0]
        : linkNode
      const title = parser.cleanText(titleNode?.text() ?? '')

      const link: ArticleLink = { url: absolute, sourceUrl: page.finalUrl }
      if (title) link.title = title

      // 封面图：列表阶段提取（详情页没有封面时的兜底来源）
      if (listRule.coverSelector) {
        const coverNode = item.findAll(listRule.coverSelector, listRule.itemSelectorType ?? 'css')[0]
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
    const page = await this.fetchPage(context, link.url)
    const fields: Record<string, FieldRule> = context.rule.config.detail?.fields ?? context.rule.config.fields ?? {}
    if (Object.keys(fields).length === 0) {
      throw new ParserError('INVALID_FIELD_RULE', '规则缺少 detail.fields，无法提取详情字段')
    }

    const result = await runPipeline(
      {
        siteId: context.site.id,
        categoryId: context.category.id,
        url: page.finalUrl,
        body: page.html,
        fields,
        clean: context.rule.config.clean,
        validate: context.rule.config.validate,
        listCoverUrl: link.coverUrl,
        metadata: {
          sourceUrl: link.sourceUrl,
          ...(link.title ? { listTitle: link.title } : {}),
          ...(link.metadata ?? {}),
        },
      },
      this.services.parser,
    )
    return { result, page }
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
