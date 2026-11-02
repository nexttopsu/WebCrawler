/**
 * 统一请求层公开 API。
 *
 * 采集核心、插件与规则测试器都从这里获取请求能力，
 * 不允许各自创建 HTTP 客户端或直接使用 axios / playwright。
 */
export * from './request-types.js'
export * from './request-errors.js'
export * from './ssrf-guard.js'
export * from './proxy-resolver.js'
export * from './http-client.js'
export * from './browser-client.js'
export * from './url-utils.js'

export const REQUEST_PACKAGE = {
  name: '@webcrawler/request',
  version: '0.6.0',
  description: '统一请求层：HTTP / 浏览器 / 代理适配',
} as const
