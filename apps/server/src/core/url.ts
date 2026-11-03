/**
 * URL 解析与规范化。
 *
 * 优先复用 request-pack 的 `resolveUrl` / `getDocumentBase`（它已处理 `<base href>`），
 * 这里只补充采集需要的规范化规则：去 fragment、去跟踪参数、统一端口与大小写。
 */
import { getDocumentBase as resolveDocumentBase, resolveUrl as resolveRequestUrl } from '../request/index.js'

/** 可以安全剔除的跟踪参数（前缀匹配）。 */
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_']

/** 可以安全剔除的跟踪参数（精确匹配）。 */
const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'yclid',
  'dclid',
  'spm',
  'scm',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
])

export interface NormalizeUrlOptions {
  /** 是否移除跟踪参数，默认 true */
  stripTracking?: boolean
  /** 是否移除 fragment，默认 true */
  stripFragment?: boolean
  /** 是否排序查询参数，默认 true */
  sortQuery?: boolean
}

/** 把相对地址解析为绝对地址；无法解析时原样返回。 */
export function resolveUrl(href: string, base?: string): string {
  if (!href) return ''
  return resolveRequestUrl(href.trim(), base)
}

/** 计算文档基准地址：优先 `<base href>`，否则用页面地址。 */
export function getDocumentBase(html: string, pageUrl: string): string {
  return resolveDocumentBase(html, pageUrl)
}

/** 规范化 URL，用于去重与入库。 */
export function normalizeUrl(input: string, options: NormalizeUrlOptions = {}): string {
  const { stripTracking = true, stripFragment = true, sortQuery = true } = options

  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return input
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return input

  url.hostname = url.hostname.toLowerCase()
  url.protocol = url.protocol.toLowerCase()

  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }

  if (stripFragment) url.hash = ''

  if (stripTracking) {
    const keep: [string, string][] = []
    for (const [key, value] of url.searchParams.entries()) {
      const lower = key.toLowerCase()
      if (TRACKING_PARAMS.has(lower)) continue
      if (TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue
      keep.push([key, value])
    }
    if (sortQuery) keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    url.search = ''
    for (const [key, value] of keep) url.searchParams.append(key, value)
  }

  return url.toString()
}

/** 两个地址是否同源（用于列表链接过滤）。 */
export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
