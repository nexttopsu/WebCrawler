import type { LogEntryDto, PaginatedData } from '@webcrawler/shared'
import { api } from './client'

export interface LogListParams {
  page?: number
  pageSize?: number
  taskId?: number
  siteId?: number
  categoryId?: number
  level?: 'debug' | 'info' | 'warn' | 'error'
  stage?: string
  keyword?: string
  from?: string
  to?: string
}

export function listLogs(params: LogListParams = {}): Promise<PaginatedData<LogEntryDto>> {
  return api.get<PaginatedData<LogEntryDto>>('/logs', params)
}

/** 按条件清理日志的返回值：实际删除的条数。 */
export interface LogClearResult {
  deleted: number
}

/** 按当前筛选条件删除日志（服务端要求至少带一个条件）。 */
export function clearLogs(params: LogListParams): Promise<LogClearResult> {
  return api.delete<LogClearResult>('/logs', params)
}
