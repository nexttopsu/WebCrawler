/**
 * Playwright 浏览器封装。
 *
 * 生命周期策略：
 * - Browser 进程全局复用，避免每次请求都启动浏览器；
 * - 每次采集创建独立 BrowserContext，Cookie / 存储互不串扰；
 * - Page 用完立即关闭，Context 随之释放；
 * - 并发页面数受 `maxPages` 限制，超出的请求排队。
 *
 * 安全策略：
 * - 打开前校验 URL；
 * - 通过 `context.route` 拦截所有导航请求（含重定向与 iframe），逐跳做 SSRF 校验；
 * - 导航结束后再次校验最终地址，作为兜底。
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { ProxySettings } from '@webcrawler/shared'
import { RequestError, RequestErrorCode } from './request-errors.js'
import type { BrowserPageOptions, BrowserPageResult } from './request-types.js'
import { formatProxyForLog } from './proxy-resolver.js'
import { SsrfBlockedError, assertUrlAllowed, type SsrfPolicy } from './ssrf-guard.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** 简单计数信号量，限制同时打开的页面数。 */
class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

/** 浏览器客户端配置。 */
export interface BrowserClientOptions {
  /** 最大并发页面数，默认 3 */
  maxPages?: number
  /** 无头模式，默认 true */
  headless?: boolean
  /** 是否向 Chromium 传递 --no-sandbox（容器环境常见需求） */
  noSandbox?: boolean
  /** 默认导航超时（毫秒） */
  timeoutMs?: number
  /** 默认视口 */
  viewport?: { width: number; height: number }
  /** 默认 SSRF 策略 */
  ssrf?: SsrfPolicy
}

/** 一次页面会话，供需要自定义操作的调用方使用。 */
export interface BrowserSession {
  page: Page
  context: BrowserContext
}

/** 把统一代理配置转成 Playwright 的 proxy 参数。 */
export function toPlaywrightProxy(
  proxy: ProxySettings,
): { server: string; username?: string; password?: string } {
  const server = `${proxy.protocol}://${proxy.host}:${proxy.port}`
  const result: { server: string; username?: string; password?: string } = { server }
  if (proxy.username) result.username = proxy.username
  if (proxy.password) result.password = proxy.password
  return result
}

/** 浏览器客户端。 */
export class BrowserClient {
  private browserPromise: Promise<Browser> | null = null
  private readonly semaphore: Semaphore
  private readonly options: Required<Pick<BrowserClientOptions, 'headless' | 'noSandbox' | 'timeoutMs' | 'maxPages'>> & {
    viewport: { width: number; height: number }
    ssrf: SsrfPolicy
  }

  constructor(options: BrowserClientOptions = {}) {
    this.options = {
      maxPages: options.maxPages ?? 3,
      headless: options.headless ?? true,
      noSandbox: options.noSandbox ?? false,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      viewport: options.viewport ?? { width: 1440, height: 900 },
      ssrf: options.ssrf ?? {},
    }
    this.semaphore = new Semaphore(Math.max(1, this.options.maxPages))
  }

  /** 当前是否已启动浏览器。 */
  get launched(): boolean {
    return this.browserPromise !== null
  }

  /** 启动（或复用）浏览器。 */
  async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium
        .launch({
          headless: this.options.headless,
          args: this.options.noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
        })
        .then((browser) => {
          browser.on('disconnected', () => {
            this.browserPromise = null
          })
          return browser
        })
        .catch((error: unknown) => {
          this.browserPromise = null
          throw new RequestError(
            RequestErrorCode.BROWSER_ERROR,
            `浏览器启动失败：${error instanceof Error ? error.message : String(error)}`,
            { cause: error, retryable: false },
          )
        })
    }
    return this.browserPromise
  }

  /** 打开页面并在回调中使用，回调结束后自动释放资源。 */
  async withPage<T>(
    options: BrowserPageOptions,
    handler: (session: BrowserSession, response: { status: number; finalUrl: string }) => Promise<T>,
  ): Promise<T> {
    const release = await this.semaphore.acquire()
    const browser = await this.getBrowser()
    const ssrf = options.ssrf ?? this.options.ssrf
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs

    let context: BrowserContext | null = null
    let page: Page | null = null
    const state: { blocked: SsrfBlockedError | null } = { blocked: null }
    const abortListener = (): void => {
      void page?.close().catch(() => undefined)
    }

    try {
      if (options.signal?.aborted) {
        throw new RequestError(RequestErrorCode.ABORTED, '请求已取消', { url: options.url })
      }

      await this.assertAllowed(options.url, ssrf)

      const contextOptions: Parameters<Browser['newContext']>[0] = {
        viewport: options.viewport ?? this.options.viewport,
      }
      if (options.userAgent) contextOptions.userAgent = options.userAgent
      if (options.proxy) contextOptions.proxy = toPlaywrightProxy(options.proxy)
      if (options.headers) contextOptions.extraHTTPHeaders = options.headers

      context = await browser.newContext(contextOptions)
      context.setDefaultTimeout(timeoutMs)
      context.setDefaultNavigationTimeout(timeoutMs)

      // 逐跳校验所有导航请求（含重定向、iframe）
      await context.route('**/*', async (route) => {
        const request = route.request()
        const type = request.resourceType()
        if (options.blockResources && (type === 'image' || type === 'font' || type === 'media')) {
          await route.abort()
          return
        }
        if (request.isNavigationRequest()) {
          try {
            await assertUrlAllowed(request.url(), ssrf)
          } catch (error) {
            if (error instanceof SsrfBlockedError) state.blocked = error
            await route.abort()
            return
          }
        }
        await route.continue()
      })

      page = await context.newPage()
      options.signal?.addEventListener('abort', abortListener, { once: true })

      const response = await page.goto(options.url, {
        waitUntil: options.waitUntil ?? 'load',
        timeout: timeoutMs,
      })

      if (state.blocked) {
        throw new RequestError(RequestErrorCode.BLOCKED_URL, state.blocked.message, {
          url: options.url,
          retryable: false,
        })
      }

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: timeoutMs })
      }

      const finalUrl = page.url()
      await this.assertAllowed(finalUrl, ssrf)

      const status = response?.status() ?? 0
      return await handler({ page, context }, { status, finalUrl })
    } catch (error) {
      if (error instanceof RequestError) throw error
      if (state.blocked) {
        throw new RequestError(RequestErrorCode.BLOCKED_URL, state.blocked.message, {
          url: options.url,
          retryable: false,
        })
      }
      if (options.signal?.aborted) {
        throw new RequestError(RequestErrorCode.ABORTED, '请求已取消', { url: options.url })
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new RequestError(RequestErrorCode.TIMEOUT, `页面加载超时（${timeoutMs}ms）`, {
          url: options.url,
          retryable: true,
          cause: error,
        })
      }
      throw new RequestError(
        RequestErrorCode.BROWSER_ERROR,
        `浏览器操作失败：${error instanceof Error ? error.message : String(error)}`,
        { url: options.url, cause: error, retryable: false },
      )
    } finally {
      options.signal?.removeEventListener('abort', abortListener)
      await context?.close().catch(() => undefined)
      release()
    }
  }

  /** 打开页面、抓取渲染结果并关闭。 */
  async fetchPage(options: BrowserPageOptions): Promise<BrowserPageResult> {
    const startedAt = performance.now()

    return this.withPage(options, async ({ page, context }, { status, finalUrl }) => {
      const screenshot = options.screenshot ? await page.screenshot({ fullPage: true }) : undefined
      const cookies = options.collectCookies
        ? (await context.cookies()).map((item) => ({
            name: item.name,
            value: item.value,
            domain: item.domain,
            path: item.path,
          }))
        : undefined

      const result: BrowserPageResult = {
        finalUrl,
        title: await page.title(),
        html: await page.content(),
        status,
        elapsedMs: Math.round(performance.now() - startedAt),
      }
      if (screenshot) result.screenshot = screenshot
      if (cookies) result.cookies = cookies
      return result
    })
  }

  /** 关闭浏览器，释放全部进程。 */
  async close(): Promise<void> {
    const pending = this.browserPromise
    this.browserPromise = null
    if (!pending) return
    try {
      const browser = await pending
      await browser.close()
    } catch {
      // 浏览器已退出时忽略关闭错误
    }
  }

  /** 日志用描述，便于定位代理问题且不泄露凭据。 */
  static describeProxy(proxy: ProxySettings | null | undefined): string {
    return formatProxyForLog(proxy)
  }

  private async assertAllowed(url: string, ssrf: SsrfPolicy): Promise<void> {
    try {
      await assertUrlAllowed(url, ssrf)
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new RequestError(RequestErrorCode.BLOCKED_URL, error.message, {
          url,
          retryable: false,
          details: { host: error.host },
        })
      }
      throw error
    }
  }
}

/** 创建浏览器客户端。 */
export function createBrowserClient(options: BrowserClientOptions = {}): BrowserClient {
  return new BrowserClient(options)
}

/** 判断给定的错误是否为「浏览器未安装」，便于给出可操作的提示。 */
export function isBrowserMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Executable doesn't exist|Please run the following command/i.test(message)
}
