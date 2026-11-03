import type { PaginatedData, ScheduleDto } from '@webcrawler/shared'
import { api } from './client'

export interface ScheduleListParams {
  page?: number
  pageSize?: number
  siteId?: number
  enabled?: 'true' | 'false'
  keyword?: string
}

export interface ScheduleInput {
  name: string
  siteId: number
  categoryIds: number[]
  taskType: 'site' | 'category' | 'batch' | 'full' | 'incremental'
  frequency: 'hourly' | 'daily' | 'weekly' | 'cron'
  hour?: number
  minute?: number
  weekday?: number
  cron?: string
  timezone?: string
  enabled?: boolean
  options?: Record<string, unknown>
  description?: string | null
}

export interface ScheduleRunResult {
  task: { id: number; status: string }
  skipped: boolean
  reason?: string
}

export function listSchedules(params: ScheduleListParams = {}): Promise<PaginatedData<ScheduleDto>> {
  return api.get<PaginatedData<ScheduleDto>>('/schedules', params)
}

export function getSchedule(id: number): Promise<ScheduleDto> {
  return api.get<ScheduleDto>(`/schedules/${id}`)
}

export function createSchedule(input: ScheduleInput): Promise<ScheduleDto> {
  return api.post<ScheduleDto>('/schedules', input)
}

export function updateSchedule(id: number, input: Partial<ScheduleInput>): Promise<ScheduleDto> {
  return api.put<ScheduleDto>(`/schedules/${id}`, input)
}

export function patchSchedule(id: number, input: Partial<ScheduleInput>): Promise<ScheduleDto> {
  return api.patch<ScheduleDto>(`/schedules/${id}`, input)
}

export function setScheduleEnabled(id: number, enabled: boolean): Promise<ScheduleDto> {
  return api.patch<ScheduleDto>(`/schedules/${id}/status`, { enabled })
}

export function runSchedule(id: number): Promise<ScheduleRunResult> {
  return api.post<ScheduleRunResult>(`/schedules/${id}/run`)
}

export function deleteSchedule(id: number): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/schedules/${id}`)
}
