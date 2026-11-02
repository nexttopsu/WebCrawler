import { getResponseStatus, type Middleware } from 'h3'
import { getRequestId } from '../lib/response.js'
import type { Logger } from '../lib/logger.js'

/**
 * 访问日志。记录方法、路径、状态码与耗时。
 *
 * 失败的请求会在这里 `throw` 出去，由外层错误中间件记录，避免重复打印。
 */
export function createRequestLogger(logger: Logger): Middleware {
  return async (event, next) => {
    const startedAt = performance.now()
    const result = await next()
    const status = getResponseStatus(event)

    logger.info(`${event.req.method} ${event.url.pathname} ${status}`, {
      requestId: getRequestId(event),
      method: event.req.method,
      path: event.url.pathname,
      status,
      durationMs: Math.round(performance.now() - startedAt),
    })

    return result
  }
}
