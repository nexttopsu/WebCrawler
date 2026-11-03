import type { DeleteResultDto, PaginatedData, SiteConnectionTestDto, SiteDetailDto, SiteDto } from '@webcrawler/shared'
import { api } from './client'

export interface SiteListParams {
  page?: number
  pageSize?: number
  keyword?: string
  status?: 'active' | 'inactive'
  pluginName?: string
}

export interface SiteInput {
  name: string
  /** 站点地址：域名由服务端从地址主机名自动获取，不再单独填写 */
  baseUrl: string
  /** 兼容旧调用：显式域名必须与站点地址主机名一致 */
  domain?: string
  pluginName?: string | null
  defaultProxyId?: number | null
  status?: 'active' | 'inactive'
  description?: string | null
}

/** 更新时可额外指定默认规则（创建阶段规则还不存在，因此不允许） */
export interface SiteUpdateInput extends SiteInput {
  defaultRuleId?: number | null
}

export function listSites(params: SiteListParams = {}): Promise<PaginatedData<SiteDto>> {
  return api.get<PaginatedData<SiteDto>>('/sites', params)
}

export function getSite(id: number): Promise<SiteDetailDto> {
  return api.get<SiteDetailDto>(`/sites/${id}`)
}

export function createSite(input: SiteInput): Promise<SiteDto> {
  return api.post<SiteDto>('/sites', input)
}

export function updateSite(id: number, input: SiteUpdateInput): Promise<SiteDto> {
  return api.put<SiteDto>(`/sites/${id}`, input)
}

export function patchSite(id: number, input: Partial<SiteUpdateInput>): Promise<SiteDto> {
  return api.patch<SiteDto>(`/sites/${id}`, input)
}

export function deleteSite(id: number, force = false): Promise<DeleteResultDto> {
  return api.delete<DeleteResultDto>(`/sites/${id}`, force ? { force: 'true' } : undefined)
}

export function setSiteStatus(id: number, status: 'active' | 'inactive'): Promise<SiteDto> {
  return api.patch<SiteDto>(`/sites/${id}/status`, { status })
}

export function testSite(id: number): Promise<SiteConnectionTestDto> {
  return api.post<SiteConnectionTestDto>(`/sites/${id}/test`)
}
