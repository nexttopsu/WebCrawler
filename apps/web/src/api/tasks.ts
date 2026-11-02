import type {
  CrawlTaskStatus,
  CrawlTaskType,
  CreateTaskInput,
  PaginatedData,
  TaskDetailDto,
  TaskDto,
} from '@webcrawler/shared'
import { api } from './client'

export interface TaskListParams {
  page?: number
  pageSize?: number
  siteId?: number
  scheduleId?: number
  status?: CrawlTaskStatus
  type?: CrawlTaskType
  trigger?: 'manual' | 'schedule' | 'retry'
  keyword?: string
  from?: string
  to?: string
}

export function listTasks(params: TaskListParams = {}): Promise<PaginatedData<TaskDto>> {
  return api.get<PaginatedData<TaskDto>>('/tasks', params)
}

export function getTask(id: number): Promise<TaskDetailDto> {
  return api.get<TaskDetailDto>(`/tasks/${id}`)
}

/** 创建任务：服务端立即返回 pending，执行在后台进行。 */
export function createTask(input: CreateTaskInput): Promise<TaskDto> {
  return api.post<TaskDto>('/tasks', input)
}

export function pauseTask(id: number): Promise<TaskDto> {
  return api.post<TaskDto>(`/tasks/${id}/pause`)
}

export function resumeTask(id: number): Promise<TaskDto> {
  return api.post<TaskDto>(`/tasks/${id}/resume`)
}

export function cancelTask(id: number): Promise<TaskDto> {
  return api.post<TaskDto>(`/tasks/${id}/cancel`)
}

export function retryTask(id: number): Promise<TaskDto> {
  return api.post<TaskDto>(`/tasks/${id}/retry`)
}

export function deleteTask(id: number): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/tasks/${id}`)
}
