import { ErrorCode } from '@webcrawler/shared'

/**
 * 业务错误基类。
 * 携带 HTTP 状态码与错误码，由错误处理中间件统一转成标准返回结构。
 */
export class AppError extends Error {
  override readonly name: string = 'AppError'

  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** 400：请求本身不合法。 */
export class BadRequestError extends AppError {
  override readonly name = 'BadRequestError'

  constructor(message = '请求不合法', details?: unknown) {
    super(400, ErrorCode.BAD_REQUEST, message, details)
  }
}

/** 400：参数校验失败，`details` 为字段级错误列表。 */
export class ValidationError extends AppError {
  override readonly name = 'ValidationError'

  constructor(message = '参数校验失败', details?: unknown) {
    super(400, ErrorCode.VALIDATION_ERROR, message, details)
  }
}

/** 404：资源或路由不存在。 */
export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError'

  constructor(message = '资源不存在', details?: unknown) {
    super(404, ErrorCode.NOT_FOUND, message, details)
  }
}

/**
 * 409：与现有数据冲突。
 *
 * 两类场景：唯一约束（域名、编号、规则名重复），
 * 以及「仍被其他记录引用而无法删除」。`details` 中给出具体的引用方。
 */
export class ConflictError extends AppError {
  override readonly name = 'ConflictError'

  constructor(message = '数据冲突', details?: unknown) {
    super(409, ErrorCode.CONFLICT, message, details)
  }
}

/** 405：路径存在，但不支持当前 HTTP 方法。 */
export class MethodNotAllowedError extends AppError {
  override readonly name = 'MethodNotAllowedError'

  constructor(message = '请求方法不被支持', details?: unknown) {
    super(405, ErrorCode.METHOD_NOT_ALLOWED, message, details)
  }
}

/**
 * 503：服务端缺少必要配置。
 *
 * 典型场景：未设置 `PROXY_SECRET_KEY` 却要保存带密码的代理。
 * 明确报错而不是退化成明文存储。
 */
export class ConfigurationError extends AppError {
  override readonly name = 'ConfigurationError'

  constructor(message = '服务端配置不完整', details?: unknown) {
    super(503, ErrorCode.CONFIGURATION_ERROR, message, details)
  }
}

/** 503：数据库不可用。 */
export class DatabaseUnavailableError extends AppError {
  override readonly name = 'DatabaseUnavailableError'

  constructor(message = '数据库不可用', options?: { cause?: unknown }) {
    super(503, ErrorCode.DATABASE_UNAVAILABLE, message, undefined, options)
  }
}
