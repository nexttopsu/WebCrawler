/**
 * 文章 URL 规范化。
 *
 * 去重的第一道防线：同一个详情页经常以多种写法出现
 * （带 `utm_*`、带锚点、query 顺序不同、大小写主机名），
 * 直接按字符串比较会把同一篇文章当成多篇重复采集。
 *
 * 规范化只做「确定安全」的改动：
 * - 去掉锚点（服务端不会因 `#` 返回不同内容）；
 * - 主机名小写、去掉默认端口；
 * - 查询参数按 key 排序；
 * - 去掉已知的营销跟踪参数（白名单，绝不按 `ref` / `from` 这类
 *   可能承载业务语义的参数做模糊删除）。
 */

/** 默认剔除的跟踪参数。只包含业界通用、对内容无影响的键。 */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'spm',
  'scm',
  'share_token',
]

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
}

export interface NormalizeUrlOptions {
  /** 追加或自定义要剔除的参数（大小写不敏感） */
  trackingParams?: readonly string[]
  /** 是否保留锚点，默认去掉 */
  keepHash?: boolean
}

/**
 * 规范化 URL。
 *
 * 无法解析的地址原样返回（去掉首尾空白），由调用方决定是否丢弃：
 * 这里不抛错，因为列表页上出现畸形链接是常态。
 */
export function normalizeArticleUrl(raw: string, options: NormalizeUrlOptions = {}): string {
  const value = raw.trim()
  if (!value) return value

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value

  // URL 解析已把主机名转小写；显式再处理一次，避免实现差异
  url.hostname = url.hostname.toLowerCase()
  if (DEFAULT_PORTS[url.protocol] === url.port) url.port = ''

  const blocked = new Set(
    [...DEFAULT_TRACKING_PARAMS, ...(options.trackingParams ?? [])].map((item) => item.toLowerCase()),
  )

  const entries = [...url.searchParams.entries()].filter(
    ([key]) => !blocked.has(key.toLowerCase()),
  )
  if (entries.length > 0) {
    entries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue.localeCompare(rightValue)
      return leftKey.localeCompare(rightKey)
    })
    const search = new URLSearchParams()
    for (const [key, entryValue] of entries) search.append(key, entryValue)
    url.search = search.toString()
  } else {
    url.search = ''
  }

  if (!options.keepHash) url.hash = ''

  // 根路径统一为 `/`，其余保留（`/a` 与 `/a/` 可能指向不同资源，不能合并）
  let result = url.toString()
  if (url.pathname === '/' && !url.search) {
    result = `${url.origin}/`
  }
  return result
}

/** 判断两个地址规范化后是否相同。 */
export function isSameArticleUrl(left: string, right: string): boolean {
  return normalizeArticleUrl(left) === normalizeArticleUrl(right)
}
