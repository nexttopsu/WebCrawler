import type { PaginatedData, ProxyDto, ProxyTestResultDto } from '@webcrawler/shared'
import { api } from './client'

export interface ProxyListParams {
  page?: number
  pageSize?: number
  keyword?: string
  type?: 'http' | 'https' | 'socks5'
  status?: 'unknown' | 'available' | 'unavailable' | 'disabled'
  enabled?: 'true' | 'false'
}

export interface ProxyInput {
  name?: string
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string | null
  /** 不传表示不改动；传 null 表示清空 */
  password?: string | null
  enabled?: boolean
}

export function listProxies(params: ProxyListParams = {}): Promise<PaginatedData<ProxyDto>> {
  return api.get<PaginatedData<ProxyDto>>('/proxies', params)
}

export function getProxy(id: number): Promise<ProxyDto> {
  return api.get<ProxyDto>(`/proxies/${id}`)
}

export function createProxy(input: ProxyInput): Promise<ProxyDto> {
  return api.post<ProxyDto>('/proxies', input)
}

export function updateProxy(id: number, input: Partial<ProxyInput>): Promise<ProxyDto> {
  return api.put<ProxyDto>(`/proxies/${id}`, input)
}

export function patchProxy(id: number, input: Partial<ProxyInput>): Promise<ProxyDto> {
  return api.patch<ProxyDto>(`/proxies/${id}`, input)
}

export function setProxyEnabled(id: number, enabled: boolean): Promise<ProxyDto> {
  return api.patch<ProxyDto>(`/proxies/${id}/status`, { enabled })
}

export function testProxy(id: number, url?: string): Promise<ProxyTestResultDto> {
  return api.post<ProxyTestResultDto>(`/proxies/${id}/test`, url ? { url } : {})
}

export function deleteProxy(id: number, force = false): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/proxies/${id}`, force ? { force: 'true' } : undefined)
}
