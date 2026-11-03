/**
 * Axios 统一封装。
 *
 * 约定：
 * - 所有接口都返回 `{ success, data, meta }`，这里统一拆包，业务层只拿 `data`；
 * - 失败一律抛 `ApiClientError`（携带 `code` / `status` / `details`），
 *   页面只需展示 `message`，需要区分时看 `code`；
 * - 401 / 403 / 404 / 500 / 超时 / 断网都翻译成可读中文，不把 axios 原始错误泄漏到界面；
 * - 分页参数由 `toQuery` 统一处理，空值不会被拼进 URL。
 */
import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios'
import type { ApiResponse } from '@webcrawler/shared'

/** 开发时走 Vite 代理（`/api`），生产用 `VITE_API_BASE_URL` 指向独立域名。 */
export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? '/api'

/** 默认请求超时。导出等大响应单独放宽。 */
export const API_TIMEOUT = 25_000

export class ApiClientError extends Error {
  override readonly name = 'ApiClientError'

  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

const STATUS_MESSAGE: Record<number, string> = {
  400: '请求参数不合法',
  401: '登录状态已失效，请重新登录',
  403: '没有访问该资源的权限',
  404: '请求的资源不存在',
  405: '该接口不支持当前请求方法',
  409: '操作与当前状态冲突',
  413: '提交的数据过大',
  429: '请求过于频繁，请稍后再试',
  500: '服务端内部错误',
  502: '网关错误，服务暂时不可用',
  503: '服务暂不可用（可能缺少必要配置）',
  504: '网关超时，请稍后重试',
}

function isApiResponse(value: unknown): value is ApiResponse<unknown> {
  return typeof value === 'object' && value !== null && 'success' in value
}

export const http: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  headers: { accept: 'application/json' },
})

http.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    throw normalizeError(error)
  },
)

/** 把 axios 的各类失败统一成 `ApiClientError`。 */
export function normalizeError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<ApiResponse<unknown>>

    if (axiosError.code === 'ERR_CANCELED') {
      return new ApiClientError('请求已取消', 'CANCELED', 0)
    }
    if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
      return new ApiClientError('请求超时，请检查网络或稍后重试', 'TIMEOUT', 0)
    }

    const payload = axiosError.response?.data
    if (isApiResponse(payload) && payload.success === false) {
      return new ApiClientError(payload.error.message, payload.error.code, axiosError.response?.status ?? 0, payload.error.details)
    }

    if (!axiosError.response) {
      return new ApiClientError('无法连接到服务端，请确认后端已启动', 'NETWORK_ERROR', 0)
    }

    const status = axiosError.response.status
    return new ApiClientError(STATUS_MESSAGE[status] ?? `请求失败（HTTP ${status}）`, 'HTTP_ERROR', status)
  }

  return new ApiClientError(error instanceof Error ? error.message : String(error), 'UNKNOWN_ERROR', 0)
}

/** 发起请求并拆包 `ApiResponse`。 */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  let response
  try {
    response = await http.request<ApiResponse<T>>(config)
  } catch (error) {
    throw normalizeError(error)
  }

  const payload = response.data
  if (!isApiResponse(payload)) {
    throw new ApiClientError('响应结构不是标准 API 格式', 'INVALID_RESPONSE', response.status)
  }
  if (payload.success === false) {
    throw new ApiClientError(payload.error.message, payload.error.code, response.status, payload.error.details)
  }
  return payload.data as T
}

/** 把对象转成查询串：忽略 `undefined` / `null` / 空字符串。 */
export function toQuery(params: object | undefined): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      search.set(key, value.join(','))
      continue
    }
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

/**
 * 查询参数。
 *
 * 这里刻意用 `object` 而不是 `Record<string, unknown>`：各业务模块的参数都是
 * interface，interface 没有隐式索引签名，直接传会报「缺少索引签名」。
 */
type Params = object | undefined

/** 常用动词的薄封装：调用处只关心路径、参数与返回类型。 */
export const api = {
  get<T>(url: string, params?: Params, config?: AxiosRequestConfig): Promise<T> {
    return request<T>({ ...config, url: `${url}${toQuery(params)}`, method: 'GET' })
  },
  post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'POST', data: body ?? {} })
  },
  put<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'PUT', data: body ?? {} })
  },
  patch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return request<T>({ ...config, url, method: 'PATCH', data: body ?? {} })
  },
  delete<T>(url: string, params?: Params, config?: AxiosRequestConfig): Promise<T> {
    return request<T>({ ...config, url: `${url}${toQuery(params)}`, method: 'DELETE' })
  },
  /** 下载文件：返回二进制与文件名（导出 CSV / JSON 用）。 */
  async download(url: string, params?: Params): Promise<{ blob: Blob; filename: string | null }> {
    let response
    try {
      response = await http.get<Blob>(`${url}${toQuery(params)}`, { responseType: 'blob' })
    } catch (error) {
      throw await blobError(error)
    }

    const disposition = String(response.headers['content-disposition'] ?? '')
    const match = /filename="?([^";]+)"?/i.exec(disposition)
    return { blob: response.data, filename: match?.[1] ?? null }
  },
}

/**
 * 导出接口出错时返回的是 JSON，但请求配置了 `responseType: 'blob'`，
 * 这里把 Blob 读回文本并还原成服务端的错误文案，避免只提示「请求失败」。
 */
async function blobError(error: unknown): Promise<ApiClientError> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const text = await error.response.data.text()
      const payload: unknown = JSON.parse(text)
      if (isApiResponse(payload) && payload.success === false) {
        return new ApiClientError(
          payload.error.message,
          payload.error.code,
          error.response.status,
          payload.error.details,
        )
      }
    } catch {
      // 解析失败时退回统一文案
    }
  }
  return normalizeError(error)
}

/** 触发浏览器下载。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立即回收会让部分浏览器下载失败，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 取可用于界面展示的错误文案。 */
/** 把字段级校验错误拼进提示，避免界面上只剩一句「请求参数校验失败」。 */
function validationDetail(error: ApiClientError): string {
  if (!Array.isArray(error.details)) return ''
  const parts = error.details
    .slice(0, 3)
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const record = item as { path?: unknown; message?: unknown }
      const path = typeof record.path === 'string' ? record.path : ''
      const message = typeof record.message === 'string' ? record.message : ''
      if (!message) return ''
      return path ? `${path} ${message}` : message
    })
    .filter((part): part is string => Boolean(part))
  return parts.join('；')
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'VALIDATION_ERROR') {
      const detail = validationDetail(error)
      if (detail) return `${error.message}：${detail}`
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}
