/**
 * 采集核心公开 API。
 *
 * 只暴露「请求 → 解析 → 清洗 → 校验 → 输出」这条链路所需的类型与实现，
 * 不包含 HTTP 服务、数据库与任务调度（分别属于 apps/server 与后续阶段）。
 */
export * from './types.js'
export * from './errors.js'
export * from './clean.js'
export * from './url.js'
export * from './json-path.js'
export * from './parser/document.js'
export * from './parser/extract.js'
export * from './parser/index.js'
export * from './pipeline.js'
export * from './engine.js'
export * from './task/limiter.js'
export * from './task/pagination.js'

export const CORE_PACKAGE = {
  name: '@webcrawler/core',
  version: '0.6.0',
  description: '采集核心：解析、清洗、校验与管道',
} as const
