import type { CrawlRequestOptions, ProxySettings, WaitUntil } from '@webcrawler/shared'

/** 支持的 HTTP 方法。采集以 GET 为主，POST 用于表单型接口。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

/** 查询参数值。数组展开为同名多值。 */
export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>

/** 一次请求的完整参数。 */
export interface HttpRequestOptions {
  url: string
  method?: HttpMethod
  query?: QueryParams
  headers?: Record<string, string>
  /** 请求体：对象按 JSON 发送；字符串 / Buffer 原样发送 */
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  /** 响应体大小上限（字节），默认 5 MiB */
  maxBytes?: number
  /** 重定向次数上限，默认 5 */
  maxRedirects?: number
  /** 失败重试次数，默认 0；仅 GET / HEAD 生效 */
  retries?: number
  retryDelayMs?: number
  userAgent?: string
  /** 本次请求使用的代理；null / undefined 表示直连 */
  proxy?: ProxySettings | null
  /** 文本编码，缺省自动识别 */
  encoding?: string
  /** Cookie 键值，按 `name=value; ...` 拼接 */
  cookies?: Record<string, string>
  /** 非 2xx 时是否抛错，默认 false（采集需要自行判断状态码） */
  throwOnHttpError?: boolean
}

/** 请求元数据。 */
export interface HttpTimings {
  /** 从发起到拿到完整响应的总耗时（含重定向） */
  totalMs: number
  /** 各跳耗时，按顺序排列 */
  hopsMs: number[]
}

/** 统一响应。原始字节与解码文本同时保留，避免把所有响应都当成 HTML。 */
export interface HttpResponse {
  status: number
  ok: boolean
  /** 响应头，键为小写；同名多值以 `, ` 连接 */
  headers: Record<string, string>
  /** 原始响应体 */
  body: Buffer
  /** 按识别出的编码解码后的文本 */
  text: string
  /** 识别出的编码 */
  charset: string
  contentType: string
  /** 内容是否为文本类型 */
  isText: boolean
  /** 最终 URL（重定向之后） */
  finalUrl: string
  /** 途经的重定向地址，按顺序排列 */
  redirects: string[]
  /** set-cookie 原值 */
  setCookies: string[]
  elapsedMs: number
  timings: HttpTimings
  /** 解析 JSON 响应体，非 JSON 或解析失败时抛错 */
  json<T = unknown>(): T
}

/** 请求客户端配置。 */
export interface RequestClientOptions {
  /** 默认超时（毫秒），默认 15000 */
  timeoutMs?: number
  /** 默认响应体上限（字节），默认 5 MiB */
  maxBytes?: number
  /** 默认重定向上限，默认 5 */
  maxRedirects?: number
  /** 默认重试次数，默认 0 */
  retries?: number
  /** 默认 User-Agent */
  userAgent?: string
  /** 默认请求头 */
  headers?: Record<string, string>
  /** 默认代理 */
  proxy?: ProxySettings | null
  /** SSRF 策略；默认禁止内网地址 */
  ssrf?: import('./ssrf-guard.js').SsrfPolicy
}

/** 浏览器模式参数。 */
export interface BrowserPageOptions {
  url: string
  proxy?: ProxySettings | null
  timeoutMs?: number
  /** 等待条件，默认 load */
  waitUntil?: WaitUntil
  /** 等待指定选择器出现 */
  waitForSelector?: string
  signal?: AbortSignal
  userAgent?: string
  viewport?: { width: number; height: number }
  /** 拦截图片 / 字体 / 媒体资源 */
  blockResources?: boolean
  /** 额外请求头 */
  headers?: Record<string, string>
  /** 是否截图 */
  screenshot?: boolean
  /** 是否返回页面 Cookie（用于后续请求复用会话） */
  collectCookies?: boolean
  ssrf?: import('./ssrf-guard.js').SsrfPolicy
}

/** 浏览器模式结果。 */
export interface BrowserPageResult {
  /** 重定向后的最终地址 */
  finalUrl: string
  title: string
  /** 渲染后的完整 HTML */
  html: string
  status: number
  elapsedMs: number
  screenshot?: Buffer
  cookies?: { name: string; value: string; domain: string; path: string }[]
}

/** 把统一的请求参数转换为 HTTP 参数，供规则复用。 */
export type CrawlOptionsForHttp = Pick<
  CrawlRequestOptions,
  'method' | 'headers' | 'query' | 'body' | 'timeoutMs' | 'encoding' | 'retries' | 'maxBytes' | 'maxRedirects' | 'userAgent' | 'cookies'
>
