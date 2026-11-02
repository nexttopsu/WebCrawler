import { getModels, type CategoryRow, type CrawlRuleRow, type ProxyRow, type SiteRow } from '@webcrawler/database'
import {
  createDefaultRuleConfig,
  type CategoryDto,
  type CrawlRuleConfig,
  type ProxySettings,
  type ProxySummaryDto,
  type RuleDto,
  type RuleSummaryDto,
  type SiteDto,
} from '@webcrawler/shared'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { decryptProxyPassword } from '../lib/proxy-secret.js'

/** 站点 / 栏目 / 规则的可空文本字段统一收敛：空串视为未填写。 */
export function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 必填文本：写入前已经过 Schema 校验，这里只做最后一道防线。 */
export function requireText(value: string | null | undefined, label: string): string {
  const trimmed = textOrNull(value)
  if (!trimmed) throw new ValidationError(`${label}不能为空`)
  return trimmed
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * 域名校验。
 *
 * 只接受「多级主机名」或 IPv4 字面量：不接受带协议、路径、端口的写法，
 * 这些属于 `baseUrl`。`localhost` 这类单标签主机名会被拒绝，
 * 因为采集目标必须是可以公开访问的站点（内网地址另有 SSRF 防线）。
 */
export function isValidDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(value) || IPV4_PATTERN.test(value)
}

/** 统一转小写并去掉结尾的点，便于唯一索引命中。 */
export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * 归一化站点基址。
 *
 * - 缺省时按 `https://{domain}` 生成；
 * - 只允许 http / https；
 * - 禁止携带用户名密码（凭据应走代理或请求头，不能写进 URL）；
 * - 主机名必须与 domain 一致，避免「站点声明 A、实际抓 B」的错配；
 * - 去掉末尾斜杠，保留路径前缀（如 `https://example.com/news`）。
 */
export function resolveBaseUrl(raw: string | undefined | null, domain: string): string {
  const value = raw?.trim() || `https://${domain}`
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new ValidationError('baseUrl 不是合法的 URL', [
      { path: 'baseUrl', message: '不是合法的 URL', code: 'invalid_format' },
    ])
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('baseUrl 只支持 http / https', [
      { path: 'baseUrl', message: '只支持 http / https', code: 'invalid_value' },
    ])
  }
  if (url.username || url.password) {
    throw new ValidationError('baseUrl 不能包含用户名或密码', [
      { path: 'baseUrl', message: '不能包含用户名或密码', code: 'invalid_value' },
    ])
  }
  if (url.hostname.toLowerCase() !== domain.toLowerCase()) {
    throw new ValidationError('baseUrl 的主机名必须与 domain 一致', [
      { path: 'baseUrl', message: `主机名应为 ${domain}`, code: 'invalid_value' },
    ])
  }
  if (url.search || url.hash) {
    throw new ValidationError('baseUrl 不能包含查询参数或锚点', [
      { path: 'baseUrl', message: '不能包含查询参数或锚点', code: 'invalid_value' },
    ])
  }

  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** 数据库中的 0/1 转布尔。 */
export function toBoolean(value: number | null): boolean {
  return value === 1
}

/** 布尔转数据库中的 0/1。 */
export function fromBoolean(value: boolean | undefined, fallback: boolean): number {
  return (value ?? fallback) ? 1 : 0
}

/** 网站行 → API 结构。 */
export function toSiteDto(row: SiteRow): SiteDto {
  return {
    id: row.id,
    name: row.name ?? '',
    domain: row.domain ?? '',
    baseUrl: row.baseUrl ?? '',
    pluginName: row.pluginName,
    defaultProxyId: row.defaultProxyId,
    status: row.status === 'inactive' ? 'inactive' : 'active',
    description: row.description,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

/** 栏目行 → API 结构。 */
export function toCategoryDto(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    siteId: row.siteId ?? 0,
    name: row.name ?? '',
    code: row.code,
    listUrl: row.listUrl ?? '',
    ruleId: row.ruleId,
    proxyId: row.proxyId,
    enabled: toBoolean(row.enabled),
    crawlInterval: row.crawlInterval ?? 0,
    sortOrder: row.sortOrder ?? 0,
    description: row.description,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

/** 规则行 → API 结构。配置解析失败时回落到默认配置，避免列表接口整体失败。 */
export function toRuleDto(row: CrawlRuleRow): RuleDto {
  const parsed = parseStoredConfig(row.config)
  return {
    id: row.id,
    siteId: row.siteId ?? 0,
    categoryId: row.categoryId,
    name: row.name ?? '',
    version: row.version ?? 1,
    status: row.status === 'disabled' ? 'disabled' : 'enabled',
    description: row.description,
    configVersion: parsed.config.version,
    config: parsed.config,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

/** 规则摘要，用于站点 / 栏目详情。 */
export function toRuleSummary(row: CrawlRuleRow): RuleSummaryDto {
  return {
    id: row.id,
    name: row.name ?? '',
    version: row.version ?? 1,
    status: row.status === 'disabled' ? 'disabled' : 'enabled',
  }
}

/** 代理摘要：不返回用户名与密码。 */
export function toProxySummary(row: ProxyRow): ProxySummaryDto {
  return {
    id: row.id,
    protocol: row.protocol ?? '',
    host: row.host ?? '',
    port: row.port ?? 0,
    status: row.status ?? 'unknown',
  }
}

/** 解析数据库中存储的规则 JSON。 */
export function parseStoredConfig(raw: string | null): { config: CrawlRuleConfig; valid: boolean } {
  if (!raw) return { config: createDefaultRuleConfig(), valid: false }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: createDefaultRuleConfig(), valid: false }
    }
    return { config: parsed as CrawlRuleConfig, valid: true }
  } catch {
    return { config: createDefaultRuleConfig(), valid: false }
  }
}

export function findSiteOrThrow(id: number): SiteRow {
  const site = getModels().site.findById(id)
  if (!site) throw new NotFoundError(`站点 ${id} 不存在`)
  return site
}

export function findCategoryOrThrow(id: number): CategoryRow {
  const category = getModels().category.findById(id)
  if (!category) throw new NotFoundError(`栏目 ${id} 不存在`)
  return category
}

export function findRuleOrThrow(id: number): CrawlRuleRow {
  const rule = getModels().crawlRule.findById(id)
  if (!rule) throw new NotFoundError(`规则 ${id} 不存在`)
  return rule
}

export function findProxyOrThrow(id: number): ProxyRow {
  const proxy = getModels().proxy.findById(id)
  if (!proxy) throw new NotFoundError(`代理 ${id} 不存在`)
  return proxy
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http', 'https', 'socks5'])

/**
 * 校验代理可用性。
 *
 * 代理尚未提供管理接口（第五阶段），但栏目 / 站点可以引用已有代理记录，
 * 因此这里必须校验「存在、协议受支持、未被禁用」，而不是把不可用的代理写进配置。
 */
export function assertProxyUsable(proxyId: number): ProxyRow {
  const proxy = findProxyOrThrow(proxyId)
  const protocol = proxy.protocol ?? ''
  if (!SUPPORTED_PROXY_PROTOCOLS.has(protocol)) {
    throw new ValidationError(`代理 ${proxyId} 的协议 ${protocol || '(空)'} 不受支持`, [
      { path: 'proxyId', message: '仅支持 http / https / socks5 代理', code: 'invalid_value' },
    ])
  }
  if (proxy.status === 'disabled' || proxy.enabled === 0) {
    throw new ConflictError(`代理 ${proxyId} 已被禁用，不能关联`, { proxyId })
  }
  if (!proxy.host || !proxy.port) {
    throw new ConflictError(`代理 ${proxyId} 缺少主机或端口，不能关联`, { proxyId })
  }
  return proxy
}

/**
 * 代理行 → 请求层使用的设置。
 *
 * 密码在读取时解密，只在内存中传递；解密失败（密钥缺失或更换）会显式抛错，
 * 而不是带着空密码去请求、把问题伪装成「代理不可用」。
 */
export function proxyToSettings(row: ProxyRow): ProxySettings {
  const protocol = row.protocol === 'https' ? 'https' : row.protocol === 'socks5' ? 'socks5' : 'http'
  const password = decryptProxyPassword(row.password)
  return {
    protocol,
    host: row.host ?? '',
    port: row.port ?? 0,
    ...(row.username ? { username: row.username } : {}),
    ...(password ? { password } : {}),
  }
}
