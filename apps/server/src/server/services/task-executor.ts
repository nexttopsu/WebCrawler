import { getModels } from '../../database/index.js'
import {
  AbortedError,
  buildPageUrlRange,
  CrawlEngine,
  createParser,
  delay,
  IntervalLimiter,
  PaginationError,
  resolveRequestMode,
  type FlowPluginRunner,
  type ParserPluginRunner,
  type PluginFetchPage,
} from '../../core/index.js'
import {
  createBrowserClient,
  createScopedRequest,
  RequestError,
  type BrowserClient,
  type RequestClient,
} from '../../request/index.js'
import { describePlugin, type PluginContext, type PluginRegistry } from '../../plugin-system/index.js'
import {
  attr as rpAttr,
  html2object as rpHtml2Object,
  html as rpHtml,
  json as rpJson,
  loop as rpLoop,
  nullable as rpNullable,
  object as rpObject,
  text as rpText,
} from 'request-pack'
import {
  CollectScope,
  CrawlTaskStatus,
  CrawlTaskType,
  normalizeArticleUrl,
  type ArticleLink,
  type CrawlContext,
  type CrawlLogger,
  type TaskCategorySnapshot,
  type TaskCheckpoint,
  type TaskConfigSnapshot,
  type TaskRunSummary,
} from '../../shared/index.js'
import type { Logger } from '../lib/logger.js'
import {
  applyArticleDetail,
  listArticlesForDetailCollect,
  listArticlesForDetailCollectByIds,
  markArticleDetailFailed,
  saveCrawledArticle,
  saveListArticle,
  findArticleIdByUrl,
} from './article-service.js'
import { assertProxyUsable, findSiteOrThrow, proxyToSettings } from './common.js'
import { writeLog } from './log-service.js'
import { recordProxyUsage } from './proxy-stats.js'
import { getSettings } from './settings-service.js'
import { getTaskRow, normalizeTaskStatus, parseTaskCheckpoint, parseTaskSnapshot, patchTask, transitionTask } from './task-service.js'

/** 执行器依赖。 */
export interface TaskExecutorDeps {
  request: RequestClient
  logger: Logger
  /** 插件注册表：解析规则里的 parserPlugins 插件链；缺省时不执行解析器插件 */
  pluginRegistry?: PluginRegistry
}

/** 运行时注入的控制信号。 */
export interface RunControl {
  /** 取消信号；暂停不使用 abort（要让当前请求自然结束） */
  signal: AbortSignal
  /** 是否已请求暂停 */
  shouldPause: () => boolean
}

/** 断点中最多保留的 URL 数：避免单行无限膨胀，超出后只保留最近的记录。 */
const CHECKPOINT_URL_LIMIT = 5000

/** 进度写库的最小间隔。 */
const FLUSH_INTERVAL_MS = 800

/** 单篇失败重试的退避基数。 */
const RETRY_BACKOFF_MS = 300

interface RunStats {
  total: number
  success: number
  failed: number
  skipped: number
  currentPage: number
  totalPages: number
}

/** 任务配置快照里的 options 形状。 */
type TaskOptionsLike = TaskConfigSnapshot['options']

/** 行里的任务类型字符串 → 枚举；未知值按栏目采集处理。 */
function normalizeTaskType(raw: string | null | undefined): CrawlTaskType {
  const value = (raw ?? '') as CrawlTaskType
  return (Object.values(CrawlTaskType) as string[]).includes(value) ? value : CrawlTaskType.CATEGORY
}

function errorInfo(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof RequestError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  if (error instanceof PaginationError) {
    return { code: error.code, message: error.message, retryable: false }
  }
  if (error instanceof AbortedError) {
    return { code: 'ABORTED', message: error.message, retryable: false }
  }
  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * 插件上下文：请求器、抓取能力与解析器由调用方注入，日志写进任务日志。
 *
 * `request` 不是平台单例，而是「绑定本次代理」的视图：测试器里选的代理、
 * 栏目配置的代理，对插件内部发出的请求同样生效。显式传 `{ proxy: null }`
 * 可以让单次请求直连。
 */
function buildPluginContext(
  context: CrawlContext,
  services: {
    request: RequestClient
    parser: ReturnType<typeof createParser>
    fetchPage?: PluginFetchPage
  },
): PluginContext {
  const proxy = context.proxy ?? null
  return {
    request: createScopedRequest(services.request, proxy),
    // 没有引擎注入时（例如单独测 runner）给出明确错误，而不是静默走 HTTP
    fetchPage:
      services.fetchPage ??
      (async () => {
        throw new Error('当前运行环境没有提供 fetchPage，请改用 ctx.request 或检查引擎注入')
      }),
    proxy,
    mode: resolveRequestMode(context),
    parser: services.parser,
    // request-pack 的整页解析能力原样注入：插件按 schema 解析页面不用再引依赖
    html2object: rpHtml2Object,
    schema: {
      text: rpText,
      html: rpHtml,
      attr: rpAttr,
      json: rpJson,
      loop: rpLoop,
      object: rpObject,
      nullable: rpNullable,
    },
    // 本次运行的页面配置快照：站点 / 栏目 / 生效规则 / 请求配置，插件可以按需读取
    site: context.site,
    category: context.category,
    rule: context.rule,
    requestOptions: context.requestOptions,
    logger: {
      info: (message: string) => context.logger.info(message),
      warn: (message: string) => context.logger.warn(message),
      error: (message: string) => context.logger.error(message),
    },
    siteId: context.site.id,
    categoryId: context.category.id,
  }
}

/** 规则里配置的 parserPlugins → 依次执行的插件链运行器（列表与详情阶段共用）。 */
export function createParserPluginRunner(
  registry: PluginRegistry,
  request: RequestClient,
  parser: ReturnType<typeof createParser> = createParser(),
): ParserPluginRunner {
  return async (data, context, source) => {
    // 名单按阶段取：列表用 list.parserPlugins，详情用顶层 parserPlugins，互不影响
    const ids =
      source.stage === 'list'
        ? (context.rule.config.list?.parserPlugins ?? [])
        : (context.rule.config.parserPlugins ?? [])
    let current = data
    for (const id of ids) {
      const plugin = registry.getParser(id, source.stage)
      if (!plugin) {
        const other = registry.get(id)
        const expected = source.stage === 'list' ? 'parseList' : 'parseDetail'
        if (other) {
          throw new Error(`插件 "${id}" 是${describePlugin(other)}，没有导出 ${expected}，不能用于该阶段`)
        }
        throw new Error(`插件 "${id}" 不是已启用的解析器插件，请检查插件管理页`)
      }
      const handler = source.stage === 'list' ? plugin.parseList! : plugin.parseDetail!
      const output = await handler(
        source.url,
        current,
        buildPluginContext(context, {
          request,
          parser,
          ...(source.fetchPage ? { fetchPage: source.fetchPage } : {}),
        }),
      )
      if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error(`解析器插件 "${id}" 必须返回字段对象`)
      }
      current = output as Record<string, unknown>
    }
    return current
  }
}

/**
 * 全流程插件运行器。
 *
 * 列表阶段调 `getList`，详情阶段调 `getDetail`；插件没实现对应函数时直接报错，
 * 避免“挂上了但结果为空”。一个插件可以同时实现两个函数。
 */
export function createFlowPluginRunner(
  registry: PluginRegistry,
  request: RequestClient,
  parser: ReturnType<typeof createParser> = createParser(),
): FlowPluginRunner {
  return async ({ pluginId, slot, url, context, fetchPage }) => {
    const plugin = registry.getFlow(pluginId, slot)
    if (!plugin) {
      const other = registry.get(pluginId)
      const expected = slot === 'list' ? 'getList' : 'getDetail'
      if (other) {
        throw new Error(`插件 "${pluginId}" 是${describePlugin(other)}，没有导出 ${expected}，不能用于该阶段`)
      }
      throw new Error(`插件 "${pluginId}" 未启用或不存在，请检查插件管理页`)
    }

    const ctx = buildPluginContext(context, {
      request,
      parser,
      ...(fetchPage ? { fetchPage } : {}),
    })
    if (slot === 'list') return plugin.getList!(url, ctx)
    return plugin.getDetail!(url, ctx)
  }
}

/** 执行单个任务。 */
export class TaskExecutor {
  constructor(private readonly deps: TaskExecutorDeps) {}

  async run(taskId: number, control: RunControl): Promise<TaskRunSummary> {
    const startedAtMs = performance.now()
    const row = getTaskRow(taskId)
    const snapshot = parseTaskSnapshot(row.configSnapshot)

    if (!snapshot) {
      this.fail(taskId, '任务缺少可用的配置快照，无法执行；请重新创建任务')
      return this.summary(taskId, startedAtMs)
    }

    const options = snapshot.options ?? {}
    const maxDurationMs = options.maxDurationMs ?? 30 * 60 * 1000
    const timeoutSignal = AbortSignal.timeout(maxDurationMs)
    const signal = AbortSignal.any([control.signal, timeoutSignal])

    const stats: RunStats = {
      total: row.totalCount ?? 0,
      success: row.successCount ?? 0,
      failed: row.failedCount ?? 0,
      skipped: row.skippedCount ?? 0,
      currentPage: row.currentPage ?? 0,
      totalPages: row.totalPages ?? 0,
    }

    const checkpoint: TaskCheckpoint = parseTaskCheckpoint(row.checkpoint) ?? {
      completedCategoryIds: [],
      page: 0,
      processedUrls: [],
      lastUrl: null,
      updatedAt: new Date().toISOString(),
    }
    const completedCategories = new Set(checkpoint.completedCategoryIds)
    const processed = new Set(checkpoint.processedUrls.map((url) => normalizeArticleUrl(url)))
    // 只用于「本轮发现」计数，不复用断点：否则恢复后总数会变小，
    // 进度条会出现「越跑越少」的观感；断点内已处理的链接统一计入 skipped。
    const seen = new Set<string>()

    transitionTask(taskId, CrawlTaskStatus.RUNNING, {
      startedAt: row.startedAt ?? new Date().toISOString(),
      attempts: (row.attempts ?? 0) + 1,
      errorSummary: null,
      completedAt: null,
    })
    writeLog({
      taskId,
      siteId: snapshot.siteId,
      level: 'info',
      stage: 'task',
      message: '任务开始执行',
      detail: { categories: snapshot.categories.length, urls: snapshot.urls.length },
    })

    const limiter = new IntervalLimiter(options.rateLimitMs ?? 300)
    const needsBrowser = snapshot.categories.some(
      (item) => item.config.request?.mode === 'browser' || item.config.browser?.enabled === true,
    )
    let browser: BrowserClient | null = null
    if (needsBrowser) {
      try {
        browser = createBrowserClient({ headless: getSettings().browserHeadless })
      } catch (error) {
        this.fail(taskId, `浏览器模式初始化失败：${errorInfo(error).message}`)
        return this.summary(taskId, startedAtMs)
      }
    }

    const engine = new CrawlEngine({
      request: this.deps.request,
      browser,
      parserPluginRunner: this.deps.pluginRegistry
        ? createParserPluginRunner(this.deps.pluginRegistry, this.deps.request)
        : undefined,
      flowPluginRunner: this.deps.pluginRegistry
        ? createFlowPluginRunner(this.deps.pluginRegistry, this.deps.request)
        : undefined,
    })
    const errors: string[] = []
    let lastFlushAt = 0

    const flush = (force: boolean): void => {
      const now = Date.now()
      if (!force && now - lastFlushAt < FLUSH_INTERVAL_MS) return
      lastFlushAt = now
      checkpoint.updatedAt = new Date().toISOString()
      checkpoint.completedCategoryIds = [...completedCategories]
      checkpoint.processedUrls = [...processed].slice(-CHECKPOINT_URL_LIMIT)
      patchTask(taskId, {
        totalCount: stats.total,
        successCount: stats.success,
        failedCount: stats.failed,
        skippedCount: stats.skipped,
        currentPage: stats.currentPage,
        totalPages: stats.totalPages,
        checkpoint: JSON.stringify(checkpoint),
      })
    }

    const paused = (): boolean => control.shouldPause()
    const aborted = (): boolean => signal.aborted

    try {
      if (snapshot.categories.length === 0) {
        throw new Error('任务快照中没有可执行的栏目')
      }

      const targets: Array<{ category: TaskCategorySnapshot; urls: string[] }> =
        snapshot.urls.length > 0
          ? [{ category: snapshot.categories[0]!, urls: snapshot.urls }]
          : snapshot.categories.map((category) => ({ category, urls: [] }))

      const taskType = normalizeTaskType(row.type)
      // 「仅列表」有两种来源：任务类型本身，或规则/任务选项把采集范围设成了 list。
      // 后者让「单栏目 / 全站 / 增量」这类任务也能只抓列表，详情留待补采。
      const listOnly =
        taskType === CrawlTaskType.LIST ||
        (taskType !== CrawlTaskType.DETAIL && snapshot.options.collectScope === CollectScope.LIST)
      if (listOnly) {
        await this.runListStage({ taskId, snapshot, targets, engine, options, stats, checkpoint, seen, processed, completedCategories, signal, aborted, limiter, flush, errors, loggerOf: (category) => this.createCrawlLogger(taskId, snapshot.siteId, category.categoryId) })
      } else if (taskType === CrawlTaskType.DETAIL) {
        await this.runDetailStage({ taskId, snapshot, targets, engine, options, stats, checkpoint, processed, completedCategories, signal, aborted, limiter, flush, errors, loggerOf: (category) => this.createCrawlLogger(taskId, snapshot.siteId, category.categoryId) })
      } else {
        for (const target of targets) {
        if (aborted() || paused()) break
        const { category } = target
        if (completedCategories.has(category.categoryId)) continue

        const proxy = this.resolveProxy(category, errors)
        const categoryKey = `${snapshot.siteId}:${category.categoryId}`
        const logger = this.createCrawlLogger(taskId, snapshot.siteId, category.categoryId)

        let pageUrls: string[]
        try {
          if (target.urls.length > 0) {
            pageUrls = target.urls
          } else {
            const pagination = category.config.list?.pagination ?? category.config.pagination
            const startPage = Math.max(1, options.startPage ?? 1)
            const endPage = options.endPage ?? options.maxPages ?? 1
            pageUrls =
              options.followPagination === false
                ? [category.listUrl]
                : buildPageUrlRange(category.listUrl, pagination, startPage, endPage)
          }
        } catch (error) {
          const info = errorInfo(error)
          stats.failed += 1
          errors.push(`栏目「${category.name}」分页配置不可执行：${info.message}`)
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            level: 'error',
            stage: 'list',
            message: `分页配置不可执行：${info.message}`,
          })
          completedCategories.add(category.categoryId)
          flush(true)
          continue
        }

        // `urls` 类型的地址本身就是待抓列表，不存在翻页：只跑一轮，
        // 否则外层按 URL 个数循环、每轮又处理全部 URL，会把同一篇算多次。
        const pageCount = target.urls.length > 0 ? 1 : pageUrls.length
        stats.totalPages = Math.max(stats.totalPages, pageCount)

        // 列表页或分页层面的失败：该栏目不算完成，重试时可以重新抓
        let categoryFailed = false
        const startPage = target.urls.length > 0 ? 1 : Math.max(1, checkpoint.page || 1)
        for (let pageIndex = startPage - 1; pageIndex < pageCount; pageIndex += 1) {
          if (aborted() || paused()) break
          const pageUrl = pageUrls[pageIndex]!
          stats.currentPage = pageIndex + 1
          checkpoint.page = pageIndex + 1

          let links: ArticleLink[]
          if (target.urls.length > 0) {
            links = target.urls.map((url) => ({ url, sourceUrl: url }))
          } else {
            try {
              const page = await limiter.run(
                categoryKey,
                () =>
                  engine.listPage(
                    this.buildContext(snapshot, category, pageUrl, signal, proxy, taskId, logger),
                  ),
                signal,
              )
              links = page.links
              writeLog({
                taskId,
                siteId: snapshot.siteId,
                categoryId: category.categoryId,
                url: page.finalUrl,
                level: 'debug',
                stage: 'list',
                message: `列表页第 ${pageIndex + 1} 页命中 ${page.itemCount} 个列表项，提取 ${page.links.length} 条链接`,
                detail: { duplicateCount: page.duplicateCount, status: page.status, mode: page.mode },
              })
            } catch (error) {
              if (aborted()) break
              const info = errorInfo(error)
              stats.failed += 1
              categoryFailed = true
              errors.push(`栏目「${category.name}」第 ${pageIndex + 1} 页列表抓取失败：${info.message}`)
              writeLog({
                taskId,
                siteId: snapshot.siteId,
                categoryId: category.categoryId,
                url: pageUrl,
                level: 'error',
                stage: 'list',
                message: `列表抓取失败：${info.message}`,
                detail: { code: info.code },
              })
              continue
            }
          }

          // 只把「本任务还没见过」的链接计入总数，暂停恢复后重复抓同一页不会重复计数
          for (const link of links) {
            const normalized = normalizeArticleUrl(link.url)
            if (seen.has(normalized)) continue
            seen.add(normalized)
            stats.total += 1
          }

          for (const link of links) {
            if (aborted() || paused()) break
            const normalized = normalizeArticleUrl(link.url)
            if (processed.has(normalized)) {
              // 断点里已经处理过：恢复后不再重复请求，但要让统计能看出来
              stats.skipped += 1
              checkpoint.lastUrl = normalized
              flush(false)
              continue
            }

            if (options.incremental && findArticleIdByUrl(normalized)) {
              stats.skipped += 1
              processed.add(normalized)
              checkpoint.lastUrl = normalized
              flush(false)
              continue
            }

            const outcome = await this.processLink({
              taskId,
              snapshot,
              category,
              link,
              proxy,
              categoryKey,
              limiter,
              engine,
              signal,
              logger,
              retries: options.retries ?? 1,
              publishedAfter: options.publishedAfter,
              publishedBefore: options.publishedBefore,
            })

            checkpoint.lastUrl = normalized
            if (outcome.status === 'failed') {
              stats.failed += 1
              errors.push(outcome.reason)
            } else {
              processed.add(normalized)
              if (outcome.status === 'skipped') stats.skipped += 1
              else stats.success += 1
            }
            flush(false)
          }

          flush(true)
        }

        if (!categoryFailed) {
          completedCategories.add(category.categoryId)
          checkpoint.page = 0
        }
        flush(true)
      }
      }
    } finally {
      flush(true)
      if (browser) {
        await browser.close().catch(() => undefined)
      }
    }

    const current = getTaskRow(taskId)
    const currentStatus = normalizeTaskStatus(current.status)

    if (currentStatus === CrawlTaskStatus.CANCELLED) {
      writeLog({ taskId, level: 'warn', stage: 'task', message: '任务已取消，保留断点' })
      return this.summary(taskId, startedAtMs)
    }
    if (paused() && currentStatus === CrawlTaskStatus.RUNNING) {
      transitionTask(taskId, CrawlTaskStatus.PAUSED)
      writeLog({ taskId, level: 'info', stage: 'task', message: '任务已暂停，保留断点' })
      return this.summary(taskId, startedAtMs)
    }
    if (paused()) {
      return this.summary(taskId, startedAtMs)
    }
    if (timeoutSignal.aborted) {
      this.fail(taskId, `任务执行超过 ${Math.round(maxDurationMs / 1000)} 秒，已终止`)
      return this.summary(taskId, startedAtMs)
    }

    const errorSummary = errors.length > 0 ? summarizeErrors(errors) : null
    const nothingSucceeded = stats.success === 0 && stats.skipped === 0 && stats.failed > 0
    if (nothingSucceeded) {
      this.fail(taskId, errorSummary ?? '任务执行失败')
      return this.summary(taskId, startedAtMs)
    }

    transitionTask(taskId, CrawlTaskStatus.COMPLETED, {
      completedAt: new Date().toISOString(),
      currentPage: stats.currentPage,
      totalPages: stats.totalPages,
      totalCount: stats.total,
      successCount: stats.success,
      failedCount: stats.failed,
      skippedCount: stats.skipped,
      errorSummary,
    })
    writeLog({
      taskId,
      siteId: snapshot.siteId,
      level: errorSummary ? 'warn' : 'info',
      stage: 'task',
      message: `任务完成：成功 ${stats.success}，失败 ${stats.failed}，跳过 ${stats.skipped}`,
      detail: { elapsedMs: Math.round(performance.now() - startedAtMs) },
    })
    return this.summary(taskId, startedAtMs)
  }

  /** 处理单篇：抓取（含重试）→ 解析 → 入库。异常在这里被隔离，不中断整批。 */
  private async processLink(input: {
    taskId: number
    snapshot: TaskConfigSnapshot
    category: TaskCategorySnapshot
    link: ArticleLink
    proxy: ReturnType<typeof proxyToSettings> | null
    categoryKey: string
    limiter: IntervalLimiter
    engine: CrawlEngine
    signal: AbortSignal
    logger: CrawlLogger
    retries: number
    publishedAfter?: string
    publishedBefore?: string
  }): Promise<{ status: 'success' | 'skipped' | 'failed'; reason: string }> {
    const { taskId, snapshot, category, link, proxy, categoryKey, limiter, engine, signal } = input
    const attempts = Math.max(1, (input.retries ?? 0) + 1)
    let lastError: { code: string; message: string } | null = null

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const context = this.buildContext(
          snapshot,
          category,
          link.url,
          signal,
          proxy,
          taskId,
          input.logger,
        )
        const { result, page } = await limiter.run(
          categoryKey,
          () => engine.fetchAndParse(context, link),
          signal,
        )

        if (category.proxyId) recordProxyUsage(category.proxyId, true)

        if (!result.article) {
          const message = result.errors.join('；') || '数据校验未通过'
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            url: link.url,
            level: 'warn',
            stage: 'validate',
            message: `文章未通过校验：${message}`,
            detail: { missing: result.missing },
          })
          return { status: 'failed', reason: `「${link.title ?? link.url}」校验失败：${message}` }
        }

        const outcome = saveCrawledArticle(
          {
            article: result.article,
            siteId: snapshot.siteId,
            categoryId: category.categoryId > 0 ? category.categoryId : null,
            taskId,
            rawHtml: page.html,
          },
          {
            ...(input.publishedAfter ? { articleTimeAfter: input.publishedAfter } : {}),
            ...(input.publishedBefore ? { articleTimeBefore: input.publishedBefore } : {}),
          },
        )

        if (outcome.status === 'skipped') {
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            url: link.url,
            level: 'debug',
            stage: 'save',
            message: `跳过：${outcome.reason ?? '重复或未变化'}`,
            detail: { articleId: outcome.articleId },
          })
        }
        return { status: outcome.status === 'skipped' ? 'skipped' : 'success', reason: outcome.reason ?? '' }
      } catch (error) {
        if (signal.aborted) {
          return { status: 'failed', reason: `「${link.url}」请求被取消` }
        }
        const info = errorInfo(error)
        lastError = info
        if (category.proxyId) recordProxyUsage(category.proxyId, false)
        if (info.retryable && attempt < attempts) {
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            url: link.url,
            level: 'warn',
            stage: 'request',
            message: `第 ${attempt} 次抓取失败，准备重试：${info.message}`,
            detail: { code: info.code },
          })
          try {
            await delay(RETRY_BACKOFF_MS * attempt, signal)
          } catch {
            return { status: 'failed', reason: `「${link.url}」重试等待时被取消` }
          }
          continue
        }
        break
      }
    }

    const message = lastError?.message ?? '未知错误'
    writeLog({
      taskId,
      siteId: snapshot.siteId,
      categoryId: category.categoryId,
      url: link.url,
      level: 'error',
      stage: 'request',
      message: `文章抓取失败：${message}`,
      detail: { code: lastError?.code ?? 'UNKNOWN' },
    })
    return { status: 'failed', reason: `「${link.title ?? link.url}」抓取失败：${message}` }
  }

  /**
   * 仅列表采集：抓列表页（含分页），命中即入库（title + url 必填），
   * detailStatus 记为 pending，详情由「详情补采」任务单独处理。
   */
  private async runListStage(input: {
    taskId: number
    snapshot: TaskConfigSnapshot
    targets: Array<{ category: TaskCategorySnapshot; urls: string[] }>
    engine: CrawlEngine
    options: TaskOptionsLike
    stats: RunStats
    checkpoint: TaskCheckpoint
    seen: Set<string>
    processed: Set<string>
    completedCategories: Set<number>
    signal: AbortSignal
    aborted: () => boolean
    limiter: IntervalLimiter
    flush: (force: boolean) => void
    errors: string[]
    loggerOf: (category: TaskCategorySnapshot) => CrawlLogger
  }): Promise<void> {
    const { taskId, snapshot, stats, checkpoint, processed, completedCategories, flush, errors, engine } = input

    for (const target of input.targets) {
      if (input.aborted()) break
      const { category } = target
      if (completedCategories.has(category.categoryId)) continue

      const proxy = this.resolveProxy(category, errors)
      const categoryKey = `${snapshot.siteId}:${category.categoryId}`
      const logger = input.loggerOf(category)

      let pageUrls: string[]
      try {
        if (target.urls.length > 0) {
          pageUrls = target.urls
        } else {
          const pagination = category.config.list?.pagination ?? category.config.pagination
          const startPage = Math.max(1, input.options.startPage ?? 1)
          const endPage = input.options.endPage ?? input.options.maxPages ?? 1
          pageUrls =
            input.options.followPagination === false
              ? [category.listUrl]
              : buildPageUrlRange(category.listUrl, pagination, startPage, endPage)
        }
      } catch (error) {
        const info = errorInfo(error)
        stats.failed += 1
        errors.push(`栏目「${category.name}」分页配置不可执行：${info.message}`)
        completedCategories.add(category.categoryId)
        flush(true)
        continue
      }

      const pageCount = target.urls.length > 0 ? 1 : pageUrls.length
      stats.totalPages = Math.max(stats.totalPages, pageCount)
      let categoryFailed = false

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        if (input.aborted()) break
        const pageUrl = pageUrls[pageIndex]!
        stats.currentPage = pageIndex + 1
        checkpoint.page = pageIndex + 1

        let links: ArticleLink[]
        try {
          const page = await input.limiter.run(
            categoryKey,
            () => engine.listPage(this.buildContext(snapshot, category, pageUrl, input.signal, proxy, taskId, logger)),
            input.signal,
          )
          links = page.links
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            url: page.finalUrl,
            level: 'debug',
            stage: 'list',
            message: `列表页第 ${pageIndex + 1} 页命中 ${page.itemCount} 个列表项，提取 ${page.links.length} 条链接`,
            detail: { duplicateCount: page.duplicateCount },
          })
        } catch (error) {
          if (input.aborted()) break
          const info = errorInfo(error)
          stats.failed += 1
          categoryFailed = true
          errors.push(`栏目「${category.name}」第 ${pageIndex + 1} 页列表抓取失败：${info.message}`)
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            url: pageUrl,
            level: 'error',
            stage: 'list',
            message: `列表抓取失败：${info.message}`,
            detail: { code: info.code },
          })
          continue
        }

        for (const link of links) {
          if (input.aborted()) break
          const normalized = normalizeArticleUrl(link.url)
          if (input.seen.has(normalized)) continue
          input.seen.add(normalized)
          if (processed.has(normalized)) {
            stats.skipped += 1
            checkpoint.lastUrl = normalized
            flush(false)
            continue
          }

          const outcome = saveListArticle({
            siteId: snapshot.siteId,
            categoryId: category.categoryId > 0 ? category.categoryId : null,
            taskId,
            title: link.title ?? '',
            url: link.url,
            coverUrl: link.coverUrl ?? null,
            // 列表阶段抽到的内置字段直接入库；详情阶段抽不到时由合并逻辑保留
            ...(link.author ? { author: link.author } : {}),
            ...(link.summary ? { summary: link.summary } : {}),
            ...(link.content ? { content: link.content } : {}),
            ...(link.articleTime ? { articleTime: link.articleTime } : {}),
            ...(link.metadata ? { extra: link.metadata } : {}),
          })

          processed.add(normalized)
          checkpoint.lastUrl = normalized
          if (outcome.status === 'created') {
            stats.total += 1
            stats.success += 1
          } else {
            stats.skipped += 1
            if (outcome.reason && outcome.reason !== '已存在') {
              errors.push(`「${link.title ?? link.url}」列表入库跳过：${outcome.reason}`)
            }
          }
          flush(false)
        }
        flush(true)
      }

      if (!categoryFailed) {
        completedCategories.add(category.categoryId)
        checkpoint.page = 0
      }
      flush(true)
    }
  }

  /**
   * 详情补采：只处理 detailStatus ≠ collected 的文章，逐篇抓详情页，
   * 同名字段有值才覆盖列表阶段的值；成功置 collected、失败置 failed（可重试）。
   */
  private async runDetailStage(input: {
    taskId: number
    snapshot: TaskConfigSnapshot
    targets: Array<{ category: TaskCategorySnapshot; urls: string[] }>
    engine: CrawlEngine
    options: TaskOptionsLike
    stats: RunStats
    checkpoint: TaskCheckpoint
    processed: Set<string>
    completedCategories: Set<number>
    signal: AbortSignal
    aborted: () => boolean
    limiter: IntervalLimiter
    flush: (force: boolean) => void
    errors: string[]
    loggerOf: (category: TaskCategorySnapshot) => CrawlLogger
  }): Promise<void> {
    const { taskId, snapshot, stats, checkpoint, processed, completedCategories, flush, errors } = input

    for (const target of input.targets) {
      if (input.aborted()) break
      const { category } = target
      if (completedCategories.has(category.categoryId)) continue

      const proxy = this.resolveProxy(category, errors)
      const categoryKey = `${snapshot.siteId}:${category.categoryId}`
      const logger = input.loggerOf(category)

      // 指定了 articleIds 时只处理这些文章（文章页「补采选中」走这条路径），
      // 否则按栏目整批拉取 pending / failed。
      const targetIds = input.options.articleIds?.length ? [...input.options.articleIds] : null

      // 分批拉取待补采文章，直到没有新的待处理记录或任务被中断
      for (;;) {
        if (input.aborted()) break
        const pending = targetIds
          ? listArticlesForDetailCollectByIds({
              ids: targetIds,
              siteId: snapshot.siteId,
              categoryId: category.categoryId > 0 ? category.categoryId : null,
            })
          : listArticlesForDetailCollect({
              siteId: snapshot.siteId,
              categoryId: category.categoryId > 0 ? category.categoryId : null,
              excludeUrls: processed,
              limit: 100,
            })
        if (pending.length === 0) break

        for (const article of pending) {
          if (input.aborted()) break
          const normalized = normalizeArticleUrl(article.url)
          if (processed.has(normalized)) continue
          stats.total += 1

          const link: ArticleLink = { url: article.url, sourceUrl: article.url }
          if (article.title) link.title = article.title

          const outcome = await this.processDetailArticle({
            taskId,
            snapshot,
            category,
            link,
            articleId: article.id,
            proxy,
            categoryKey,
            limiter: input.limiter,
            engine: input.engine,
            signal: input.signal,
            logger,
            retries: input.options.retries ?? 1,
          })

          processed.add(normalized)
          checkpoint.lastUrl = normalized
          if (outcome.status === 'failed') {
            stats.failed += 1
            errors.push(outcome.reason)
          } else {
            stats.success += 1
          }
          flush(false)
        }
        flush(true)
        // 指定 id 的补采只需一轮：再查还是同一批，靠 processed 过滤会空转
        if (targetIds) break
      }

      completedCategories.add(category.categoryId)
      flush(true)
    }
  }

  /** 补采单篇详情：抓取（含重试）→ 解析 → 合并入库（有值才覆盖）。 */
  private async processDetailArticle(input: {
    taskId: number
    snapshot: TaskConfigSnapshot
    category: TaskCategorySnapshot
    link: ArticleLink
    articleId: number
    proxy: ReturnType<typeof proxyToSettings> | null
    categoryKey: string
    limiter: IntervalLimiter
    engine: CrawlEngine
    signal: AbortSignal
    logger: CrawlLogger
    retries: number
  }): Promise<{ status: 'success' | 'failed'; reason: string }> {
    const { taskId, snapshot, category, link, proxy, categoryKey, limiter, engine, signal } = input
    const attempts = Math.max(1, (input.retries ?? 0) + 1)
    let lastError: { code: string; message: string } | null = null

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const context = this.buildContext(snapshot, category, link.url, signal, proxy, taskId, input.logger)
        const { result, page } = await limiter.run(
          categoryKey,
          () => engine.fetchAndParse(context, link),
          signal,
        )

        if (category.proxyId) recordProxyUsage(category.proxyId, true)

        if (!result.article) {
          const message = result.errors.join('；') || '数据校验未通过'
          markArticleDetailFailed(link.url)
          writeLog({
            taskId,
            siteId: snapshot.siteId,
            categoryId: category.categoryId,
            url: link.url,
            level: 'warn',
            stage: 'validate',
            message: `详情补采未通过校验：${message}`,
            detail: { missing: result.missing, articleId: input.articleId },
          })
          return { status: 'failed', reason: `「${link.title ?? link.url}」校验失败：${message}` }
        }

        const outcome = applyArticleDetail({
          article: result.article,
          siteId: snapshot.siteId,
          categoryId: category.categoryId > 0 ? category.categoryId : null,
          taskId,
          rawHtml: page.html,
        })
        return { status: 'success', reason: outcome.reason ?? '' }
      } catch (error) {
        if (signal.aborted) {
          return { status: 'failed', reason: `「${link.url}」请求被取消` }
        }
        const info = errorInfo(error)
        lastError = info
        if (category.proxyId) recordProxyUsage(category.proxyId, false)
        if (info.retryable && attempt < attempts) {
          try {
            await delay(RETRY_BACKOFF_MS * attempt, signal)
          } catch {
            return { status: 'failed', reason: `「${link.url}」重试等待时被取消` }
          }
          continue
        }
        break
      }
    }

    const message = lastError?.message ?? '未知错误'
    markArticleDetailFailed(link.url)
    writeLog({
      taskId,
      siteId: snapshot.siteId,
      categoryId: category.categoryId,
      url: link.url,
      level: 'error',
      stage: 'request',
      message: `详情补采失败：${message}`,
      detail: { code: lastError?.code ?? 'UNKNOWN', articleId: input.articleId },
    })
    return { status: 'failed', reason: `「${link.title ?? link.url}」详情补采失败：${message}` }
  }

  /** 解析该栏目使用的代理；代理不可用时记录错误并返回 null（直连）。 */
  private resolveProxy(category: TaskCategorySnapshot, errors: string[]) {    // 优先级：栏目（快照里已含站点默认）> 系统默认代理 > 直连
    const proxyId = category.proxyId ?? getSettings().defaultProxyId
    if (!proxyId) return null
    try {
      return proxyToSettings(assertProxyUsable(proxyId))
    } catch (error) {
      const message = errorInfo(error).message
      errors.push(`栏目「${category.name}」的代理不可用：${message}`)
      writeLog({
        level: 'error',
        stage: 'request',
        message: `代理不可用，任务将直连：${message}`,
        detail: { proxyId },
      })
      return null
    }
  }

  private buildContext(
    snapshot: TaskConfigSnapshot,
    category: TaskCategorySnapshot,
    url: string,
    signal: AbortSignal,
    proxy: ReturnType<typeof proxyToSettings> | null,
    taskId: number,
    logger: CrawlLogger,
  ): CrawlContext {
    const site = findSiteOrThrow(snapshot.siteId)
    return {
      site: {
        id: String(snapshot.siteId),
        name: site.name ?? snapshot.siteName,
        domain: site.domain ?? hostnameOf(snapshot.baseUrl),
        baseUrl: site.baseUrl ?? snapshot.baseUrl,
        pluginName: site.pluginName,
        status: site.status ?? 'active',
      },
      category: {
        id: String(category.categoryId),
        siteId: String(snapshot.siteId),
        name: category.name,
        code: null,
        listUrl: category.listUrl || url,
        enabled: true,
      },
      rule: {
        id: String(category.ruleId ?? 0),
        version: category.ruleVersion,
        config: category.config,
      },
      url,
      requestOptions: {},
      proxy,
      signal,
      logger,
      metadata: { taskId },
    }
  }

  private createCrawlLogger(taskId: number, siteId: number, categoryId: number): CrawlLogger {
    const write = (level: 'warn' | 'error', message: string, fields?: Record<string, unknown>): void => {
      writeLog({
        taskId,
        siteId,
        categoryId,
        level,
        stage: 'request',
        message,
        detail: fields,
      })
    }
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, fields) => write('warn', message, fields),
      error: (message, fields) => write('error', message, fields),
    }
  }

  private fail(taskId: number, message: string): void {
    const row = getTaskRow(taskId)
    const status = normalizeTaskStatus(row.status)
    if (status === CrawlTaskStatus.COMPLETED || status === CrawlTaskStatus.CANCELLED) return
    if (status === CrawlTaskStatus.RUNNING) {
      transitionTask(taskId, CrawlTaskStatus.FAILED, {
        errorSummary: message,
        completedAt: new Date().toISOString(),
      })
    } else {
      patchTask(taskId, { status: CrawlTaskStatus.FAILED, errorSummary: message, completedAt: new Date().toISOString() })
    }
    this.deps.logger.error(`任务 ${taskId} 失败`, { message })
    writeLog({ taskId, level: 'error', stage: 'task', message })
  }

  private summary(taskId: number, startedAtMs: number): TaskRunSummary {
    const row = getTaskRow(taskId)
    return {
      taskId,
      status: normalizeTaskStatus(row.status),
      total: row.totalCount ?? 0,
      success: row.successCount ?? 0,
      failed: row.failedCount ?? 0,
      skipped: row.skippedCount ?? 0,
      elapsedMs: Math.round(performance.now() - startedAtMs),
      errorSummary: row.errorSummary,
    }
  }
}

function summarizeErrors(errors: string[]): string {
  const unique = [...new Set(errors)]
  const head = unique.slice(0, 5).join('；')
  return unique.length > 5 ? `${head}；等共 ${unique.length} 条错误` : head
}

/** 供恢复逻辑使用：判断快照里的规则是否仍然可用。 */
export function snapshotIsRunnable(snapshot: TaskConfigSnapshot | null): boolean {
  if (!snapshot || snapshot.categories.length === 0) return false
  if (snapshot.urls.length > 0) return true
  return snapshot.categories.every((category) => {
    const config = category.config
    if (!config || typeof config !== 'object') return false
    // 列表采集需要列表选择器；详情补采只需要详情字段
    if (config.list?.itemSelector) return true
    return Object.keys(config.detail?.fields ?? config.fields ?? {}).length > 0
  })
}

/** 便利函数：读取站点是否存在（恢复时校验依赖）。 */
export function siteExists(siteId: number): boolean {
  return getModels().site.exists({ id: siteId })
}
