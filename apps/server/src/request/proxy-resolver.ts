/**
 * 代理解析与选择。
 *
 * 分工：
 * - HTTP / HTTPS 代理交给 request-pack 的原生 `proxy` 配置（axios 1.16+ 支持 CONNECT 隧道）；
 * - SOCKS5 使用 `socks-proxy-agent` 作为 axios 的 `httpAgent` / `httpsAgent`；
 * - SOCKS4 当前版本不支持，解析时保留类型，使用时明确报错，不静默降级为直连。
 *
 * 任何对外输出（日志、错误、API）都必须使用 `formatProxyForLog`，避免泄露密码。
 */
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { ProxySettings } from '../shared/index.js'
import { RequestError, RequestErrorCode } from './request-errors.js'

/** 代理来源层级，优先级从高到低。 */
export interface ProxyLayers {
  /** 任务临时指定 */
  task?: ProxySettings | null
  /** 栏目指定 */
  category?: ProxySettings | null
  /** 网站指定 */
  site?: ProxySettings | null
  /** 系统默认 */
  system?: ProxySettings | null
}

const SUPPORTED_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks5'])

/** 解析代理地址，支持 `http://user:pass@host:1080` 与 `socks5://host:1080`。 */
export function parseProxyUrl(raw: string): ProxySettings {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new RequestError(RequestErrorCode.INVALID_URL, '代理地址不能为空')
  }

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
  } catch {
    throw new RequestError(RequestErrorCode.INVALID_URL, `无法解析的代理地址：${trimmed}`)
  }

  const protocol = url.protocol.replace(':', '').toLowerCase()
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new RequestError(RequestErrorCode.UNSUPPORTED, `不支持的代理协议：${protocol}`)
  }

  const port = url.port ? Number(url.port) : defaultPort(protocol)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RequestError(RequestErrorCode.INVALID_URL, `代理端口不合法：${url.port || '(空)'}`)
  }

  if (!url.hostname) {
    throw new RequestError(RequestErrorCode.INVALID_URL, '代理地址缺少主机名')
  }

  const settings: ProxySettings = {
    protocol: protocol as ProxySettings['protocol'],
    host: url.hostname,
    port,
  }
  if (url.username) settings.username = decodeURIComponent(url.username)
  if (url.password) settings.password = decodeURIComponent(url.password)
  return settings
}

function defaultPort(protocol: string): number {
  if (protocol === 'https') return 443
  if (protocol.startsWith('socks')) return 1080
  return 8080
}

/**
 * 按优先级选择代理：任务 > 栏目 > 网站 > 系统 > 直连。
 * 只返回已配置的项，不做可用性探测（探测由调用方决定是否执行）。
 */
export function resolveProxy(layers: ProxyLayers): ProxySettings | null {
  return layers.task ?? layers.category ?? layers.site ?? layers.system ?? null
}

/** 日志 / 错误中使用的脱敏描述，绝不包含用户名与密码。 */
export function formatProxyForLog(proxy: ProxySettings | null | undefined): string {
  if (!proxy) return 'direct'
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`
}

/** 代理是否走 SOCKS 适配器。 */
export function isSocksProxy(proxy: ProxySettings | null | undefined): boolean {
  return proxy?.protocol === 'socks4' || proxy?.protocol === 'socks5'
}

/** 校验代理可用于发起真实请求；不可用时抛出 `UNSUPPORTED`。 */
export function assertProxyUsable(proxy: ProxySettings): void {
  if (proxy.protocol === 'socks4') {
    throw new RequestError(
      RequestErrorCode.UNSUPPORTED,
      '当前版本不支持 SOCKS4 代理，请改用 SOCKS5 或 HTTP 代理',
      { details: { proxy: formatProxyForLog(proxy) } },
    )
  }
  if (!proxy.host || !Number.isInteger(proxy.port)) {
    throw new RequestError(RequestErrorCode.INVALID_URL, '代理配置不完整', {
      details: { proxy: formatProxyForLog(proxy) },
    })
  }
}

/** request-pack 的原生代理配置结构（仅 http / https）。 */
export interface NativeProxyConfig {
  protocol: 'http' | 'https'
  host: string
  port: number
  auth?: { username: string; password: string }
}

/** 转换为 request-pack 需要的代理配置；SOCKS 协议请使用 `createProxyAgents`。 */
export function toNativeProxyConfig(proxy: ProxySettings): NativeProxyConfig {
  assertProxyUsable(proxy)
  if (isSocksProxy(proxy)) {
    throw new RequestError(RequestErrorCode.UNSUPPORTED, 'SOCKS 代理不能传给 request-pack 的原生 proxy 配置', {
      details: { proxy: formatProxyForLog(proxy) },
    })
  }

  const config: NativeProxyConfig = {
    protocol: proxy.protocol === 'https' ? 'https' : 'http',
    host: proxy.host,
    port: proxy.port,
  }
  if (proxy.username && proxy.password) {
    config.auth = { username: proxy.username, password: proxy.password }
  }
  return config
}

/** 为 SOCKS5 创建 axios 可用的 Agent 对。 */
export function createProxyAgents(proxy: ProxySettings): {
  httpAgent: SocksProxyAgent
  httpsAgent: SocksProxyAgent
} {
  assertProxyUsable(proxy)
  if (proxy.protocol !== 'socks5') {
    throw new RequestError(RequestErrorCode.UNSUPPORTED, '只有 SOCKS5 需要额外 Agent 适配', {
      details: { proxy: formatProxyForLog(proxy) },
    })
  }

  const auth =
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : ''
  const agent = new SocksProxyAgent(`socks5://${auth}${proxy.host}:${proxy.port}`)
  return { httpAgent: agent, httpsAgent: agent }
}

/** 代理连通性测试结果。 */
export interface ProxyTestResult {
  ok: boolean
  /** 实际耗时（毫秒） */
  elapsedMs: number
  /** 失败分类，成功时为 null */
  errorCode: RequestErrorCode | null
  /** 可直接展示的说明，已脱敏 */
  message: string
  /** 访问到的状态码（若拿到响应） */
  status?: number
}
