import type { ProxyProtocol, ProxyStatus } from './domain.js'

/**
 * 代理管理契约。
 *
 * 密码只在写入时单向进入服务端（加密存储），任何读取接口都只返回
 * `hasPassword`，不返回明文、密文或密文长度——避免被用来做离线爆破。
 */

/** 代理类型：对外只暴露这三种，SOCKS4 不在支持范围。 */
export const PROXY_TYPES = ['http', 'https', 'socks5'] as const
export type ProxyType = (typeof PROXY_TYPES)[number]

export interface ProxyDto {
  id: number
  name: string
  type: ProxyType
  host: string
  port: number
  username: string | null
  hasPassword: boolean
  enabled: boolean
  status: ProxyStatus
  lastTestAt: string | null
  lastTestStatus: string | null
  requestCount: number
  successCount: number
  failedCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 代理连通性测试结果。 */
export interface ProxyTestResultDto {
  ok: boolean
  /** 测试目标地址 */
  url: string
  statusCode: number | null
  elapsedMs: number
  message: string
  testedAt: string
}

/** 使用统计（轻量、可批量刷盘）。 */
export interface ProxyUsageDelta {
  requestCount: number
  successCount: number
  failedCount: number
  lastUsedAt: string
}

/** 协议到数据库取值的守卫，避免把历史 SOCKS4 记录当成可用代理。 */
export function toProxyType(protocol: string | null): ProxyType {
  return protocol === 'https' || protocol === 'socks5' ? protocol : 'http'
}

/** 供 DTO 与日志共用的协议判定。 */
export function isSupportedProxyProtocol(protocol: string | null): protocol is ProxyType {
  return protocol === 'http' || protocol === 'https' || protocol === 'socks5'
}

export type { ProxyProtocol, ProxyStatus }
