import type {
  PaginatedData,
  PluginDto,
  PluginErrorDto,
  PluginScanResultDto,
} from '@webcrawler/shared'
import { api } from './client'

export interface PluginListParams {
  page?: number
  pageSize?: number
  keyword?: string
  type?: 'source' | 'parser' | 'exporter' | 'hook'
  enabled?: 'true' | 'false'
  status?: 'enabled' | 'disabled' | 'incompatible' | 'invalid'
}

export function listPlugins(params: PluginListParams = {}): Promise<PaginatedData<PluginDto>> {
  return api.get<PaginatedData<PluginDto>>('/plugins', params)
}

export function getPlugin(name: string): Promise<PluginDto> {
  return api.get<PluginDto>(`/plugins/${encodeURIComponent(name)}`)
}

export function setPluginEnabled(name: string, enabled: boolean): Promise<PluginDto> {
  return api.patch<PluginDto>(`/plugins/${encodeURIComponent(name)}/status`, { enabled })
}

export function listPluginErrors(
  name: string,
  limit = 20,
): Promise<{ items: PluginErrorDto[] }> {
  return api.get<{ items: PluginErrorDto[] }>(`/plugins/${encodeURIComponent(name)}/errors`, { limit })
}

/** 扫描本地插件目录（只登记清单，不下载、不安装）。 */
export function scanPlugins(directory?: string): Promise<PluginScanResultDto> {
  return api.post<PluginScanResultDto>('/plugins/scan', directory ? { directory } : {})
}

export function refreshPlugins(): Promise<{ registered: number; failed: Array<{ name: string; error: string }> }> {
  return api.post<{ registered: number; failed: Array<{ name: string; error: string }> }>('/plugins/refresh')
}
