/**
 * 代理解析与选择。
 *
 * 只支持 HTTP / HTTPS 代理：请求侧交给 request-pack / axios 的原生 `proxy` 配置
 * （1.16+ 支持 CONNECT 隧道），浏览器侧交给 Playwright 的 `proxy` 参数。
 *
 * 任何对外输出（日志、错误、API）都必须使用 `formatProxyForLog`，避免泄露密码。
 */
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

const SUPPORTED_PROTOCOLS = new Set(['http', 'https'])

/** 解析代理地址，支持 `http://user:pass@host:8080` 与 `https://host:8443`。 */
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
    throw new RequestError(
      RequestErrorCode.UNSUPPORTED,
      `不支持的代理协议：${protocol}（仅支持 http / https）`,
    )
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
  return protocol === 'https' ? 443 : 8080
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

/** 校验代理可用于发起真实请求；配置不完整时抛出 `INVALID_URL`。 */
export function assertProxyUsable(proxy: ProxySettings): void {
  if (!proxy.host || !Number.isInteger(proxy.port)) {
    throw new RequestError(RequestErrorCode.INVALID_URL, '代理配置不完整', {
      details: { proxy: formatProxyForLog(proxy) },
    })
  }
}

/** 原生代理配置结构（axios / Playwright 共用）。 */
export interface NativeProxyConfig {
  protocol: 'http' | 'https'
  host: string
  port: number
  auth?: { username: string; password: string }
}

/** 转换为 axios / Playwright 需要的代理配置。 */
export function toNativeProxyConfig(proxy: ProxySettings): NativeProxyConfig {
  assertProxyUsable(proxy)

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
