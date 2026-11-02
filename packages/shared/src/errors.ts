/**
 * 错误码。服务端返回的 `error.code` 取值来自这里，前端据此做分支处理。
 */
export const ErrorCode = {
  /** 请求本身不合法（路由不存在、方法不支持等） */
  BAD_REQUEST: 'BAD_REQUEST',
  /** 参数校验失败，`details` 中给出具体字段 */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 资源不存在 */
  NOT_FOUND: 'NOT_FOUND',
  /** 路径存在，但不支持该 HTTP 方法 */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  /** 与现有数据冲突（唯一约束、仍被引用而无法删除） */
  CONFLICT: 'CONFLICT',
  /** 数据库不可用 */
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  /** 服务端缺少必要配置（例如代理密码加密密钥） */
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  /** 未预期的服务端异常 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
