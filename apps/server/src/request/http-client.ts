/**
 * HTTP 请求客户端。
 *
 * 基于 request-pack：用它创建配置好的 axios 实例、复用它的编码嗅探与 URL 工具。
 * 这里额外做三件事，request-pack 本身不提供：
 * 1. 手动跟随重定向，每一跳都重新做 SSRF 校验（request-pack 交给 axios 自动跟随）；
 * 2. 流式读取并限制响应体大小（避免大文件打爆内存）；
 * 3. 只对幂等请求重试（POST 绝不自动重试，防止重复提交）。
 */
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { Readable } from 'node:stream'
import { createHttp, detectCharset, utils } from 'request-pack'
import type { ProxySettings } from '../shared/index.js'
import {
  RequestError,
  RequestErrorCode,
  fromTransportError,
  isRetryableStatus,
} from './request-errors.js'
import type {
  HttpMethod,
  HttpRequestOptions,
  HttpResponse,
  QueryParams,
  RequestClientOptions,
} from './request-types.js'
import {
  assertProxyUsable,
  createProxyAgents,
  formatProxyForLog,
  isSocksProxy,
  toNativeProxyConfig,
} from './proxy-resolver.js'
import { SsrfBlockedError, assertUrlAllowed, createGuardedLookup, type SsrfPolicy } from './ssrf-guard.js'
import {
  fetchIssuerCertificates,
  isIncompleteChainError,
  parseAiaIssuerUrls,
  probeLeafCertificate,
} from './chain-recovery.js'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 重定向状态码。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'HEAD'])

/** 这些 Content-Type 视为文本，可以解码成字符串。 */
const TEXTUAL_CONTENT_TYPE = /(text\/|json|xml|javascript|xhtml|html)/i

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把查询参数拼进 URL；数组展开为同名多值。 */
export function buildUrl(url: string, query?: QueryParams): string {
  if (!query) return url
  const target = new URL(url)
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      if (value === undefined || value === null) continue
      target.searchParams.append(key, String(value))
    }
  }
  return target.toString()
}

/** 归一化响应头：键小写，同名多值以 `, ` 连接。 */
function normalizeHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return headers
}

/** 读取响应流，超过上限立即中断。 */
async function readStreamWithLimit(stream: Readable, maxBytes: number, url: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  return new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > maxBytes) {
        stream.destroy()
        reject(
          new RequestError(
            RequestErrorCode.RESPONSE_TOO_LARGE,
            `响应体超过上限（${maxBytes} 字节）`,
            { url, retryable: false, details: { maxBytes } },
          ),
        )
        return
      }
      chunks.push(buffer)
    }

    stream.on('data', onData)
    stream.once('error', (error) => {
      reject(
        new RequestError(RequestErrorCode.CONNECTION_FAILED, `读取响应失败：${error.message}`, {
          url,
          cause: error,
        }),
      )
    })
    stream.once('end', () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    })
    stream.once('close', () => {
      // 流被主动销毁（超限）时不再 resolve
      cleanup()
    })

    function cleanup(): void {
      stream.off('data', onData)
    }
  })
}

/** 丢弃响应体，释放连接。 */
function drain(stream: Readable): void {
  if (typeof stream.resume === 'function') stream.resume()
  stream.destroy?.()
}

/** 单跳结果。 */
interface HopResult {
  status: number
  headers: Record<string, string>
  setCookies: string[]
  body: Buffer
  location?: string
  elapsedMs: number
}

/**
 * 统一 HTTP 客户端。
 *
 * 所有采集请求都必须经过这里，网站插件不得自行创建 HTTP 客户端。
 */
export class RequestClient {
  private readonly http: ReturnType<typeof createHttp>
  private readonly ssrf: SsrfPolicy
  private readonly defaultTimeoutMs: number
  private readonly defaultMaxBytes: number
  private readonly defaultMaxRedirects: number
  private readonly defaultRetries: number
  private readonly defaultUserAgent: string
  private readonly defaultHeaders: Record<string, string>
  private readonly defaultProxy: ProxySettings | null
  private readonly guardedHttpAgent: HttpAgent
  private readonly guardedHttpsAgent: HttpsAgent
  /** 每个主机已补齐的中间证书（PEM），避免重复下载。 */
  private readonly chainCaCache = new Map<string, string[]>()
  /** 携带补链 CA 的 HTTPS Agent，按主机复用，close() 时统一销毁。 */
  private readonly chainHttpsAgents = new Map<string, HttpsAgent>()

  constructor(options: RequestClientOptions = {}) {
    this.ssrf = options.ssrf ?? {}
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.defaultMaxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.defaultRetries = options.retries ?? 0
    this.defaultUserAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.defaultHeaders = { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', ...options.headers }
    this.defaultProxy = options.proxy ?? null

    // 连接时校验 DNS 结果，防止 DNS rebinding
    const lookup = createGuardedLookup(this.ssrf)
    this.guardedHttpAgent = new HttpAgent({ keepAlive: true, lookup })
    this.guardedHttpsAgent = new HttpsAgent({ keepAlive: true, lookup })

    // request-pack 负责创建 axios 实例与默认值；proxy 显式传 false，避免它偷偷读取环境代理
    this.http = createHttp({
      timeout: this.defaultTimeoutMs,
      headers: { 'user-agent': this.defaultUserAgent },
      maxRedirects: 0,
    })
  }

  /** 发送请求。GET / HEAD 失败时按配置重试，其他方法不重试。 */
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const method = options.method ?? 'GET'
    const retries = Math.max(0, options.retries ?? this.defaultRetries)
    const attempts = IDEMPOTENT_METHODS.has(method) ? retries + 1 : 1

    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.send(method, options)
        // 幂等请求遇到临时性失败状态码时重试；最后一次直接返回原始响应
        if (attempt < attempts - 1 && isRetryableStatus(response.status)) {
          await delay((options.retryDelayMs ?? 300) * 2 ** attempt)
          continue
        }
        return response
      } catch (error) {
        lastError = error
        const retryable =
          error instanceof RequestError &&
          error.retryable &&
          !(error instanceof RequestError && error.code === RequestErrorCode.ABORTED)
        if (!retryable || attempt === attempts - 1) break

        const backoff = (options.retryDelayMs ?? 300) * 2 ** attempt
        await delay(backoff)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new RequestError(RequestErrorCode.CONNECTION_FAILED, '请求失败', { url: options.url })
  }

  get(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}): Promise<HttpResponse> {
    return this.request({ ...options, url, method: 'GET' })
  }

  post(
    url: string,
    body?: unknown,
    options: Omit<HttpRequestOptions, 'url' | 'method' | 'body'> = {},
  ): Promise<HttpResponse> {
    return this.request({ ...options, url, method: 'POST', body })
  }

  /** 便捷方法：直接取文本。 */
  async getText(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}): Promise<string> {
    return (await this.get(url, options)).text
  }

  /** 便捷方法：直接取 JSON。 */
  async getJson<T = unknown>(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}): Promise<T> {
    return (await this.get(url, options)).json<T>()
  }

  /** 释放底层连接池。 */
  close(): void {
    this.guardedHttpAgent.destroy()
    this.guardedHttpsAgent.destroy()
    for (const agent of this.chainHttpsAgents.values()) agent.destroy()
    this.chainHttpsAgents.clear()
  }

  private async send(method: HttpMethod, options: HttpRequestOptions): Promise<HttpResponse> {
    const startedAt = performance.now()
    const proxy = options.proxy === undefined ? this.defaultProxy : options.proxy
    const maxRedirects = Math.max(0, options.maxRedirects ?? this.defaultMaxRedirects)
    const maxBytes = options.maxBytes ?? this.defaultMaxBytes
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs

    let url = buildUrl(options.url, options.query)
    let currentMethod = method
    let body = options.body
    const redirects: string[] = []
    const hopsMs: number[] = []

    for (let hop = 0; ; hop += 1) {
      await this.assertAllowed(url)

      const hopResult = await this.sendOne(currentMethod, url, body, {
        ...options,
        timeoutMs,
        maxBytes,
        proxy,
        method: currentMethod,
      })
      hopsMs.push(hopResult.elapsedMs)

      if (REDIRECT_STATUS.has(hopResult.status) && hopResult.location) {
        if (hop < maxRedirects) {
          const nextUrl = new URL(hopResult.location, url).toString()
          redirects.push(nextUrl)
          url = nextUrl
          // 303 与 301/302 的 POST 按浏览器语义降级为 GET
          if (hopResult.status === 303 || (hopResult.status !== 307 && hopResult.status !== 308 && currentMethod === 'POST')) {
            currentMethod = 'GET'
            body = undefined
          }
          continue
        }
        throw new RequestError(
          RequestErrorCode.TOO_MANY_REDIRECTS,
          `重定向次数超过上限（${maxRedirects}）`,
          { url, retryable: false, details: { redirects } },
        )
      }

      if (hopResult.status === 407 && proxy) {
        throw new RequestError(RequestErrorCode.PROXY_ERROR, '代理要求认证或认证失败（HTTP 407）', {
          url,
          status: 407,
          retryable: false,
          details: { proxy: formatProxyForLog(proxy) },
        })
      }

      if (options.throwOnHttpError && (hopResult.status < 200 || hopResult.status >= 300)) {
        throw new RequestError(RequestErrorCode.HTTP_STATUS, `请求失败：HTTP ${hopResult.status}`, {
          url,
          status: hopResult.status,
          retryable: isRetryableStatus(hopResult.status),
          details: { redirects },
        })
      }

      const charset = detectCharset(hopResult.headers, hopResult.body) ?? options.encoding ?? 'utf-8'
      const contentType = hopResult.headers['content-type'] ?? ''
      const isText = TEXTUAL_CONTENT_TYPE.test(contentType) || hopResult.body.byteLength === 0

      let text = ''
      if (isText) {
        try {
          text = utils.decode(hopResult.body, charset)
        } catch {
          text = hopResult.body.toString('utf8')
        }
      }

      return {
        status: hopResult.status,
        ok: hopResult.status >= 200 && hopResult.status < 300,
        headers: hopResult.headers,
        body: hopResult.body,
        text,
        charset,
        contentType,
        isText,
        finalUrl: url,
        redirects,
        setCookies: hopResult.setCookies,
        elapsedMs: Math.round(performance.now() - startedAt),
        timings: { totalMs: Math.round(performance.now() - startedAt), hopsMs },
        json<T = unknown>(): T {
          try {
            return JSON.parse(text) as T
          } catch (error) {
            throw new RequestError(RequestErrorCode.INVALID_URL, '响应体不是合法 JSON', {
              url,
              details: { contentType },
              cause: error,
            })
          }
        },
      }
    }
  }

  /** 单跳请求。 */
  private async sendOne(
    method: HttpMethod,
    url: string,
    body: unknown,
    options: HttpRequestOptions,
  ): Promise<HopResult> {
    const controller = new AbortController()
    const external = options.signal
    if (external?.aborted) {
      throw new RequestError(RequestErrorCode.ABORTED, '请求已取消', { url })
    }
    const forwardAbort = (): void => controller.abort(external?.reason)
    external?.addEventListener('abort', forwardAbort, { once: true })

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)

    const headers: Record<string, string> = {
      'user-agent': options.userAgent ?? this.defaultUserAgent,
      ...this.defaultHeaders,
      ...options.headers,
    }
    if (options.cookies && Object.keys(options.cookies).length > 0) {
      headers.cookie = Object.entries(options.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')
    }

    let payload: unknown = body
    if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
      payload = undefined
    } else if (body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body)
      headers['content-type'] ??= 'application/json'
    }

    const proxy = options.proxy ?? null
    const transport = this.buildTransport(proxy)

    const startedAt = performance.now()
    const hopArgs = {
      method,
      url,
      payload,
      headers,
      timeoutMs,
      signal: controller.signal,
      maxBytes: options.maxBytes ?? this.defaultMaxBytes,
      startedAt,
      transport,
    }
    try {
      return await this.doHopRequest(hopArgs)
    } catch (error) {
      // TLS 信任链不完整（服务器漏发中间证书）时：按 AIA 自动补链后重试一次。
      // 仅直连 HTTPS 生效；补链失败或无 AIA 信息时回退到原始错误。
      if (
        !(error instanceof RequestError) &&
        !controller.signal.aborted &&
        proxy === null &&
        isIncompleteChainError(error)
      ) {
        const caCertificates = await this.recoverIssuerCertificates(url)
        if (caCertificates.length > 0) {
          return await this.doHopRequest({
            ...hopArgs,
            transport: { httpsAgent: this.getChainHttpsAgent(url, caCertificates) },
          })
        }
      }
      if (error instanceof RequestError) throw error
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        const timedOut = reason instanceof Error && reason.message === 'timeout'
        throw new RequestError(
          timedOut ? RequestErrorCode.TIMEOUT : RequestErrorCode.ABORTED,
          timedOut ? `请求超时（${timeoutMs}ms）` : '请求已取消',
          { url, cause: error },
        )
      }
      throw fromTransportError(error, url, proxy !== null)
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * 尝试从叶子证书的 AIA 扩展下载缺失的中间证书。
   *
   * 结果按主机缓存：同一主机后续请求直接命中，不再重复握手与下载。
   */
  private async recoverIssuerCertificates(url: string): Promise<string[]> {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return []
    }
    const cached = this.chainCaCache.get(host)
    if (cached) return cached

    const leaf = await probeLeafCertificate(url, this.ssrf)
    if (!leaf) return []
    const issuerUrls = parseAiaIssuerUrls(leaf)
    if (issuerUrls.length === 0) return []

    const pems = await fetchIssuerCertificates(issuerUrls, this.ssrf)
    if (pems.length === 0) return []
    this.chainCaCache.set(host, pems)
    return pems
  }

  /** 取（或创建）携带补链 CA 的 HTTPS Agent。 */
  private getChainHttpsAgent(url: string, caCertificates: string[]): HttpsAgent {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      host = url
    }
    let agent = this.chainHttpsAgents.get(host)
    if (!agent) {
      // 注意：TLS 的 ca 选项会替换默认信任列表，因此必须把 Node 内置根证书一并带上，
      // 否则中间证书的上级（根 CA）反而会找不到。
      agent = new HttpsAgent({
        keepAlive: true,
        lookup: createGuardedLookup(this.ssrf),
        ca: [...rootCertificates, ...caCertificates],
      })
      this.chainHttpsAgents.set(host, agent)
    }
    return agent
  }

  /** 执行单跳的 axios 请求并归一化响应（不含错误映射）。 */
  private async doHopRequest(args: {
    method: HttpMethod
    url: string
    payload: unknown
    headers: Record<string, string>
    timeoutMs: number
    signal: AbortSignal
    maxBytes: number
    startedAt: number
    transport: Record<string, unknown>
  }): Promise<HopResult> {
    const { method, url, payload, headers, timeoutMs, signal, maxBytes, startedAt, transport } = args
    const response = await this.http.instance.request<Readable>({
      url,
      method,
      headers,
      data: payload,
      timeout: timeoutMs,
      signal,
      responseType: 'stream',
      maxRedirects: 0,
      maxContentLength: -1,
      maxBodyLength: -1,
      validateStatus: () => true,
      decompress: true,
      ...transport,
    })

      const rawHeaders = response.headers as Record<string, unknown>
      const headersNormalized = normalizeHeaders(rawHeaders)
      const setCookiesRaw = rawHeaders['set-cookie']
      const setCookies = Array.isArray(setCookiesRaw)
        ? setCookiesRaw.map(String)
        : setCookiesRaw
          ? [String(setCookiesRaw)]
          : []

      const location = headersNormalized.location
      const isRedirect = REDIRECT_STATUS.has(response.status)

      if (isRedirect && location) {
        drain(response.data)
        return {
          status: response.status,
          headers: headersNormalized,
          setCookies,
          body: Buffer.alloc(0),
          location,
          elapsedMs: Math.round(performance.now() - startedAt),
        }
      }

      const buffer = REDIRECT_STATUS.has(response.status)
        ? Buffer.alloc(0)
        : await readStreamWithLimit(response.data, maxBytes, url)

      return {
        status: response.status,
        headers: headersNormalized,
        setCookies,
        body: buffer,
        elapsedMs: Math.round(performance.now() - startedAt),
      }
  }

  /** 根据代理类型选择传输方式。 */
  private buildTransport(proxy: ProxySettings | null): Record<string, unknown> {
    if (proxy) {
      assertProxyUsable(proxy)
      if (isSocksProxy(proxy)) {
        const agents = createProxyAgents(proxy)
        return { httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent }
      }
      return { proxy: toNativeProxyConfig(proxy) }
    }
    return { httpAgent: this.guardedHttpAgent, httpsAgent: this.guardedHttpsAgent }
  }

  /** 请求前校验 URL，把 SSRF 错误转成统一的请求异常。 */
  private async assertAllowed(url: string): Promise<void> {
    try {
      await assertUrlAllowed(url, this.ssrf)
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

/** 创建请求客户端。 */
export function createRequestClient(options: RequestClientOptions = {}): RequestClient {
  return new RequestClient(options)
}

export { formatProxyForLog }
