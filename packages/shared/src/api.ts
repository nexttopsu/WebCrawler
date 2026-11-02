/**
 * 统一的 API 返回结构。
 *
 * 所有接口（含错误）都返回该结构，前端只需判断 `success` 字段。
 */

/** 每次响应都会携带的元信息。 */
export interface ApiMeta {
  /** 服务端为本次请求生成的追踪 ID，同时写入 `x-request-id` 响应头 */
  requestId: string
  /** 响应生成时间（ISO 8601） */
  timestamp: string
}

/** 成功响应。 */
export interface ApiSuccess<T> {
  success: true
  data: T
  meta: ApiMeta
}

/** 错误体：`code` 供程序判断，`message` 供人阅读，`details` 为可选的补充信息。 */
export interface ApiErrorBody {
  code: string
  message: string
  details?: unknown
}

/** 失败响应。 */
export interface ApiFailure {
  success: false
  error: ApiErrorBody
  meta: ApiMeta
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

/** 分页数据的通用载荷，列表接口统一使用。 */
export interface PaginatedData<T> {
  items: T[]
  total: number
  page: number
  /** 每页条数（服务端会按上限收敛） */
  pageSize: number
  /** 总页数，至少为 1（空结果时为 1） */
  totalPages: number
}

/** 类型守卫：判断响应是否成功。 */
export function isApiSuccess<T>(response: ApiResponse<T>): response is ApiSuccess<T> {
  return response.success === true
}
