import type { CrawlErrorStage, LogLevel } from './domain.js'

/**
 * 任务日志契约。
 *
 * 日志与文章错误共用一张表：级别区分 info / warn / error，
 * `stage` 标明发生在列表、详情、解析、校验、落库还是任务生命周期。
 * 所有 URL 写入前都会脱敏（见服务端 `lib/redact.ts`），
 * 代理密码、Cookie、Authorization 永不落库。
 */
export interface LogEntryDto {
  id: number
  taskId: number | null
  siteId: number | null
  categoryId: number | null
  url: string | null
  level: LogLevel
  stage: CrawlErrorStage | string
  message: string
  detail: Record<string, unknown> | null
  createdAt: string
}

/** 日志查询的公共过滤条件（服务端 Schema 的对外形态）。 */
export interface LogQuery {
  taskId?: number
  siteId?: number
  categoryId?: number
  level?: LogLevel
  stage?: string
  keyword?: string
  /** ISO 8601，闭区间 */
  from?: string
  to?: string
}
