import { randomUUID } from 'node:crypto'
import { HTTPError, setHeader, type Middleware } from 'h3'
import { ErrorCode } from '../../shared/index.js'
import { AppError } from '../errors.js'
import { jsonFail, setRequestId } from '../lib/response.js'
import type { Logger } from '../lib/logger.js'

interface ResolvedError {
  statusCode: number
  code: ErrorCode
  message: string
  details?: unknown
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { value: String(error) }
}

function resolveError(error: unknown, isProduction: boolean): ResolvedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }

  // h3 内部抛出的错误（路由不存在、请求体解析失败等）也转成统一结构
  if (HTTPError.isError(error)) {
    if (error.status === 404) {
      return { statusCode: 404, code: ErrorCode.NOT_FOUND, message: '接口不存在' }
    }
    return {
      statusCode: error.status,
      code: error.status < 500 ? ErrorCode.BAD_REQUEST : ErrorCode.INTERNAL_ERROR,
      message: error.message || '请求不合法',
    }
  }

  return {
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: isProduction ? '服务器内部错误' : error instanceof Error ? error.message : '服务器内部错误',
  }
}

/**
 * 最外层中间件：生成请求 ID，并把所有异常收敛为统一的失败结构。
 *
 * 必须最先注册，才能覆盖后续中间件与路由处理器抛出的错误。
 */
export function createErrorHandler(logger: Logger, isProduction: boolean): Middleware {
  return async (event, next) => {
    const requestId = randomUUID()
    setRequestId(event, requestId)
    setHeader(event, 'x-request-id', requestId)

    try {
      return await next()
    } catch (error) {
      const resolved = resolveError(error, isProduction)
      const meta = {
        requestId,
        method: event.req.method,
        path: event.url.pathname,
        statusCode: resolved.statusCode,
        code: resolved.code,
      }

      if (resolved.statusCode >= 500) {
        logger.error('请求处理失败', { ...meta, error: describeError(error) })
      } else {
        logger.warn('请求被拒绝', meta)
      }

      return jsonFail(event, resolved.statusCode, resolved.code, resolved.message, resolved.details)
    }
  }
}
