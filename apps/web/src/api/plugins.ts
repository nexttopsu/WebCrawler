import type { PaginatedData, PluginDto, PluginErrorDto } from '@webcrawler/shared'
import { api } from './client'

export interface PluginListParams {
  page?: number
  pageSize?: number
  keyword?: string
  /** flow = 全流程插件（getList / getDetail），parser = 解析器插件（parseList / parseDetail） */
  type?: 'flow' | 'parser'
  enabled?: 'true' | 'false'
  status?: 'enabled' | 'disabled' | 'invalid'
}

export function listPlugins(params: PluginListParams = {}): Promise<PaginatedData<PluginDto>> {
  return api.get<PaginatedData<PluginDto>>('/plugins', params)
}

/** 插件 id 即源码里 `config.id`，也是规则里引用插件的键。 */
export function getPlugin(id: string): Promise<PluginDto> {
  return api.get<PluginDto>(`/plugins/${encodeURIComponent(id)}`)
}

/** 启用 / 停用插件。插件已加载在内存里，切换立即生效。 */
export function setPluginEnabled(id: string, enabled: boolean): Promise<PluginDto> {
  return api.patch<PluginDto>(`/plugins/${encodeURIComponent(id)}/status`, { enabled })
}

export function listPluginErrors(id: string, limit = 20): Promise<{ items: PluginErrorDto[] }> {
  return api.get<{ items: PluginErrorDto[] }>(`/plugins/${encodeURIComponent(id)}/errors`, { limit })
}
