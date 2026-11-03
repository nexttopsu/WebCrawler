/**
 * 统一请求异常。
 *
 * 无论 HTTP、浏览器还是代理失败，对外都抛出同一个 `RequestError`，
 * 上层据 `code` 分类处理（是否重试、是否记录、是否跳过该 URL）。
 */

/** 请求失败分类。 */
export const RequestErrorCode = {
  /** URL 无法解析或协议不被支持 */
  INVALID_URL: 'INVALID_URL',
  /** 被 SSRF 策略拦截 */
  BLOCKED_URL: 'BLOCKED_URL',
  /** DNS 解析失败 */
  DNS_FAILED: 'DNS_FAILED',
  /** 超时 */
  TIMEOUT: 'TIMEOUT',
  /** 被 AbortSignal 取消 */
  ABORTED: 'ABORTED',
  /** 连接失败、被重置等网络层错误 */
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  /** 重定向次数超限 */
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  /** 响应体超过大小上限 */
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  /** 服务端返回了非 2xx 状态码，且调用方要求抛错 */
  HTTP_STATUS: 'HTTP_STATUS',
  /** 代理不可用或代理认证失败 */
  PROXY_ERROR: 'PROXY_ERROR',
  /** 浏览器启动、导航或截图失败 */
  BROWSER_ERROR: 'BROWSER_ERROR',
  /** 当前版本不支持的能力（例如 SOCKS4） */
  UNSUPPORTED: 'UNSUPPORTED',
} as const
export type RequestErrorCode = (typeof RequestErrorCode)[keyof typeof RequestErrorCode]

/** 构造 `RequestError` 的附加信息。 */
export interface RequestErrorInit {
  url?: string
  /** HTTP 状态码；未拿到响应时为 undefined */
  status?: number
  /** 该错误是否适合重试 */
  retryable?: boolean
  /** 补充信息，不得包含代理密码、Cookie、Authorization 等敏感值 */
  details?: unknown
  cause?: unknown
}

/** 统一请求异常。 */
export class RequestError extends Error {
  override readonly name = 'RequestError'

  readonly code: RequestErrorCode
  readonly url: string | undefined
  readonly status: number | undefined
  readonly retryable: boolean
  readonly details: unknown

  constructor(code: RequestErrorCode, message: string, init: RequestErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.code = code
    this.url = init.url
    this.status = init.status
    this.retryable = init.retryable ?? isRetryableCode(code)
    this.details = init.details
  }

  /** 序列化为可安全写入日志的结构。 */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      url: this.url,
      status: this.status,
      retryable: this.retryable,
    }
  }
}

/** 默认的重试判定：网络抖动与超时可以重试，SSRF / 参数错误不重试。 */
function isRetryableCode(code: RequestErrorCode): boolean {
  return (
    code === RequestErrorCode.TIMEOUT ||
    code === RequestErrorCode.CONNECTION_FAILED ||
    code === RequestErrorCode.DNS_FAILED ||
    code === RequestErrorCode.PROXY_ERROR
  )
}

/** 这些状态码代表临时性故障，可以重试。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

/** axios 错误码到统一错误码的映射。 */
const AXIOS_CODE_MAP: Record<string, RequestErrorCode> = {
  ECONNABORTED: RequestErrorCode.TIMEOUT,
  ETIMEDOUT: RequestErrorCode.TIMEOUT,
  ERR_CANCELED: RequestErrorCode.ABORTED,
  ENOTFOUND: RequestErrorCode.DNS_FAILED,
  EAI_AGAIN: RequestErrorCode.DNS_FAILED,
  ECONNREFUSED: RequestErrorCode.CONNECTION_FAILED,
  ECONNRESET: RequestErrorCode.CONNECTION_FAILED,
  EPIPE: RequestErrorCode.CONNECTION_FAILED,
  EHOSTUNREACH: RequestErrorCode.CONNECTION_FAILED,
  ENETUNREACH: RequestErrorCode.CONNECTION_FAILED,
  ERR_FR_TOO_MANY_REDIRECTS: RequestErrorCode.TOO_MANY_REDIRECTS,
  ERR_BAD_RESPONSE: RequestErrorCode.CONNECTION_FAILED,
}

/** 把 axios / Node 的底层错误转成统一异常。 */
export function fromTransportError(error: unknown, url: string, proxyUsed = false): RequestError {
  if (error instanceof RequestError) return error

  const raw = error as { code?: string; message?: string; name?: string; response?: { status?: number } }
  const mapped = raw?.code ? AXIOS_CODE_MAP[raw.code] : undefined
  const status = raw?.response?.status

  if (mapped) {
    if (mapped === RequestErrorCode.CONNECTION_FAILED && proxyUsed) {
      return new RequestError(RequestErrorCode.PROXY_ERROR, `代理连接失败：${raw.message ?? '未知错误'}`, {
        url,
        status,
        cause: error,
      })
    }
    return new RequestError(mapped, describeTransportError(mapped, raw.message), { url, status, cause: error })
  }

  if (raw?.name === 'AbortError') {
    return new RequestError(RequestErrorCode.ABORTED, '请求已取消', { url, cause: error })
  }

  return new RequestError(RequestErrorCode.CONNECTION_FAILED, `请求失败：${raw?.message ?? String(error)}`, {
    url,
    status,
    cause: error,
  })
}

function describeTransportError(code: RequestErrorCode, message?: string): string {
  switch (code) {
    case RequestErrorCode.TIMEOUT:
      return '请求超时'
    case RequestErrorCode.ABORTED:
      return '请求已取消'
    case RequestErrorCode.DNS_FAILED:
      return `域名解析失败${message ? `：${message}` : ''}`
    default:
      return `连接失败${message ? `：${message}` : ''}`
  }
}
