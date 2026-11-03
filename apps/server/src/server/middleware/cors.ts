import { handleCors, type Middleware } from 'h3'

/**
 * CORS 中间件。
 *
 * 预检请求由 `handleCors` 直接返回 204，其余请求补上响应头后继续。
 * 允许的来源由 `CORS_ORIGIN` 环境变量控制：`*` 或逗号分隔的白名单。
 */
export function createCorsMiddleware(origins: '*' | string[]): Middleware {
  return async (event, next) => {
    const handled = handleCors(event, {
      origin: origins === '*' ? '*' : origins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id'],
      maxAge: '86400',
      credentials: false,
    })

    if (handled !== false) return handled
    return next()
  }
}
