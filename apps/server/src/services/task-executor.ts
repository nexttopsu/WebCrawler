import { getModels } from '@webcrawler/database'
import {
  AbortedError,
  buildPageUrls,
  CrawlEngine,
  delay,
  IntervalLimiter,
  PaginationError,
} from '@webcrawler/core'
import { createBrowserClient, RequestError, type BrowserClient, type RequestClient } from '@webcrawler/request'
import {
  CrawlTaskStatus,
  normalizeArticleUrl,
  type ArticleLink,
  type CrawlContext,
  type CrawlLogger,
  type TaskCategorySnapshot,
  type TaskCheckpoint,
  type TaskConfigSnapshot,
  type TaskRunSummary,
} from '@webcrawler/shared'
import type { Logger } from '../lib/logger.js'
import { saveCrawledArticle, findArticleIdByUrl } from './article-service.js'
import { assertProxyUsable, findSiteOrThrow, proxyToSettings } from './common.js'
import { writeLog } from './log-service.js'
import { recordProxyUsage } from './proxy-stats.js'
import { getSettings } from './settings-service.js'
import { getTaskRow, normalizeTaskStatus, parseTaskCheckpoint, parseTaskSnapshot, patchTask, transitionTask } from './task-service.js'

/** 执行器依赖。 */
export interface TaskExecutorDeps {
  request: RequestClient
  logger: Logger
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

    const engine = new CrawlEngine({ request: this.deps.request, browser })
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
            const maxPages =
              options.maxPages ?? pagination?.maxPages ?? 1
            pageUrls =
              options.followPagination === false
                ? [category.listUrl]
                : buildPageUrls(category.listUrl, pagination, maxPages)
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
              dedupeByContentHash: options.dedupeByContentHash !== false,
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
    dedupeByContentHash: boolean
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
            dedupeByContentHash: input.dedupeByContentHash,
            ...(input.publishedAfter ? { publishedAfter: input.publishedAfter } : {}),
            ...(input.publishedBefore ? { publishedBefore: input.publishedBefore } : {}),
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

  /** 解析该栏目使用的代理；代理不可用时记录错误并返回 null（直连）。 */
  private resolveProxy(category: TaskCategorySnapshot, errors: string[]) {
    // 优先级：栏目（快照里已含站点默认）> 系统默认代理 > 直连
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
    return Boolean(config.list?.itemSelector)
  })
}

/** 便利函数：读取站点是否存在（恢复时校验依赖）。 */
export function siteExists(siteId: number): boolean {
  return getModels().site.exists({ id: siteId })
}
