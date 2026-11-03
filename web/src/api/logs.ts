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
