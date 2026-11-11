import type {
  DebugCaptureStartInput,
  DebugCaptureStatusDto,
  DebugContentType,
  DebugSampleDetailDto,
  DebugSampleDto,
  PaginatedData,
} from '@webcrawler/shared'
import { api } from './client'

/** 调试数据列表参数：列表不返回 raw（原文），只给字节数。 */
export interface DebugSampleListParams {
  page?: number
  pageSize?: number
  keyword?: string
  contentType?: DebugContentType
  overridable?: 'true' | 'false'
}

/** 新增 / 编辑调试数据的字段。 */
export interface DebugSamplePayload {
  url: string
  raw: string
  statusCode?: number
  contentType?: DebugContentType
  note?: string | null
  overridable?: boolean
}

/** 批量删除：给 ids（勾选）或筛选条件（至少一个）。 */
export interface DebugSampleDeleteParams {
  ids?: string
  keyword?: string
  contentType?: DebugContentType
  overridable?: 'true' | 'false'
}

/** 批量设置「可覆盖」：overridable 是目标值，ids / 筛选条件圈定范围（至少一个）。 */
export interface DebugSampleOverridableParams {
  overridable: 'true' | 'false'
  ids?: string
  keyword?: string
  contentType?: DebugContentType
}

export function listDebugSamples(
  params: DebugSampleListParams = {},
): Promise<PaginatedData<DebugSampleDto>> {
  return api.get<PaginatedData<DebugSampleDto>>('/debug-data', params)
}

/** 单条详情：含 raw，仅在查看 / 编辑时调用。 */
export function getDebugSample(id: number): Promise<DebugSampleDetailDto> {
  return api.get<DebugSampleDetailDto>(`/debug-data/${id}`)
}

export function createDebugSample(payload: DebugSamplePayload): Promise<DebugSampleDetailDto> {
  return api.post<DebugSampleDetailDto>('/debug-data', payload)
}

export function updateDebugSample(
  id: number,
  payload: Partial<DebugSamplePayload>,
): Promise<DebugSampleDetailDto> {
  return api.put<DebugSampleDetailDto>(`/debug-data/${id}`, payload)
}

export function deleteDebugSample(id: number): Promise<{ deleted: number }> {
  return api.delete<{ deleted: number }>(`/debug-data/${id}`)
}

export function deleteDebugSamples(params: DebugSampleDeleteParams): Promise<{ deleted: number }> {
  return api.delete<{ deleted: number }>('/debug-data', params)
}

/** 批量设置「可覆盖」：不可覆盖的条目不会被捕获浏览器更新。 */
export function setDebugSamplesOverridable(
  params: DebugSampleOverridableParams,
): Promise<{ updated: number }> {
  return api.patch<{ updated: number }>('/debug-data/overridable', undefined, { params })
}

/* ------------------------------- 捕获浏览器 ------------------------------- */

/** 捕获浏览器状态（页面每 2s 轮询一次）。 */
export function getDebugCaptureStatus(): Promise<DebugCaptureStatusDto> {
  return api.get<DebugCaptureStatusDto>('/debug-data/capture/status')
}

/** 启动捕获浏览器：浏览器在服务端机器上打开，访问的网页自动入库。 */
export function startDebugCapture(
  input: DebugCaptureStartInput = {},
): Promise<DebugCaptureStatusDto> {
  return api.post<DebugCaptureStatusDto>('/debug-data/capture/start', input)
}

/** 停止捕获浏览器（幂等）。 */
export function stopDebugCapture(): Promise<DebugCaptureStatusDto> {
  return api.post<DebugCaptureStatusDto>('/debug-data/capture/stop')
}
