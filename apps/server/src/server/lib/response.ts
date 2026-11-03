import { setResponseStatus, type H3Event } from 'h3'
import type { ApiFailure, ApiMeta, ApiSuccess, ErrorCode } from '../../shared/index.js'

const REQUEST_ID_KEY = 'requestId'

/** 由错误处理中间件生成的请求 ID。 */
export function getRequestId(event: H3Event): string {
  const value = event.context[REQUEST_ID_KEY]
  return typeof value === 'string' ? value : 'unknown'
}

export function setRequestId(event: H3Event, requestId: string): void {
  event.context[REQUEST_ID_KEY] = requestId
}

function createMeta(requestId: string): ApiMeta {
  return { requestId, timestamp: new Date().toISOString() }
}

/** 构造成功响应并写入状态码。 */
export function jsonOk<T>(event: H3Event, data: T, statusCode = 200): ApiSuccess<T> {
  setResponseStatus(event, statusCode)
  return {
    success: true,
    data,
    meta: createMeta(getRequestId(event)),
  }
}

/** 构造失败响应并写入状态码。 */
export function jsonFail(
  event: H3Event,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): ApiFailure {
  setResponseStatus(event, statusCode)
  return {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details },
    meta: createMeta(getRequestId(event)),
  }
}
