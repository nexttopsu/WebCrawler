import type { EventHandler } from 'h3'

/** 一条 API 路由声明。集中注册便于统一前缀、405 判定与后续的鉴权挂载。 */
export interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  handler: EventHandler
}
