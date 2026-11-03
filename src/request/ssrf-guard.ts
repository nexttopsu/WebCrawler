/**
 * SSRF 防护。
 *
 * 三层防线：
 * 1. 协议白名单：只允许 http / https。
 * 2. 请求前校验：主机名黑名单 + DNS 解析结果检查（含 IPv4 / IPv6 私网、回环、链路本地、保留段）。
 * 3. 连接时校验：注入自定义 `lookup`，在真正建立连接的那一刻再过滤一次解析结果，
 *    避免「校验通过后 DNS 改指向内网」的 rebinding 攻击。
 *
 * 每次重定向都会重新执行第 2 层校验（见 http-client / browser-client）。
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'

/** SSRF 策略。默认禁止任何内网 / 保留地址。 */
export interface SsrfPolicy {
  /**
   * 是否允许访问内网地址。
   * 仅用于本地测试站点，生产环境必须保持 false。
   */
  allowPrivateNetwork?: boolean
  /** 额外允许的主机名（精确匹配，忽略大小写） */
  allowedHosts?: string[]
}

/** 被 SSRF 策略拦截时抛出的错误。 */
export class SsrfBlockedError extends Error {
  override readonly name = 'SsrfBlockedError'

  constructor(
    message: string,
    readonly host: string,
  ) {
    super(message)
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

/** IPv4 私网 / 保留网段。 */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4ToInt(base)
  if (baseValue === null) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (baseValue & mask)
}

/** 判断 IPv4 是否属于私网 / 保留地址。 */
export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return true
  return BLOCKED_V4.some(([base, bits]) => inV4Range(value, base, bits))
}

/** 把 IPv6 展开成 8 个 16 位分组；无法解析时返回 null。 */
function expandIpv6(input: string): number[] | null {
  const ip = input.split('%')[0]?.toLowerCase() ?? ''
  if (!ip.includes(':')) return null

  const toGroups = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      if (!piece) return null
      if (piece.includes('.')) {
        // 末尾内嵌的 IPv4，例如 ::ffff:127.0.0.1
        const v4 = ipv4ToInt(piece)
        if (v4 === null) return null
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null

  if (halves.length === 2) {
    const head = toGroups(halves[0] ?? '')
    const tail = toGroups(halves[1] ?? '')
    if (!head || !tail) return null
    if (head.length + tail.length > 7) return null
    return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
  }

  const groups = toGroups(ip)
  return groups && groups.length === 8 ? groups : null
}

function v4FromGroups(high: number, low: number): string {
  const value = high * 65536 + low
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

/** 判断 IPv6 是否属于私网 / 保留地址。 */
export function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip)
  if (!groups || groups.length !== 8) return true

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]

  // ::（未指定地址）与 ::1（回环）
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true
  }
  // fc00::/7 唯一本地地址
  if ((g0 & 0xfe00) === 0xfc00) return true
  // fe80::/10 链路本地
  if ((g0 & 0xffc0) === 0xfe80) return true
  // ff00::/8 组播
  if ((g0 & 0xff00) === 0xff00) return true
  // 2001:db8::/32 文档地址、2002::/16 6to4、100::/64 丢弃前缀
  if (g0 === 0x2001 && g1 === 0x0db8) return true
  if (g0 === 0x2002) return true
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true
  // ::ffff:0:0/96 IPv4 映射地址，按内嵌的 IPv4 判断
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(v4FromGroups(g6, g7))
  }
  // 64:ff9b::/96 NAT64，按内嵌 IPv4 判断
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(v4FromGroups(g6, g7))
  }
  return false
}

/** 判断任意 IP 字面量是否属于禁止访问的地址。无法识别的输入按「禁止」处理。 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip.split('%')[0] ?? ip)
  if (family === 4) return isBlockedIpv4(ip)
  if (family === 6) return isBlockedIpv6(ip)
  return true
}

/** 主机名是否在黑名单中（localhost、云元数据域名等）。 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function isAllowedHost(hostname: string, policy: SsrfPolicy): boolean {
  if (policy.allowPrivateNetwork) return true
  const host = hostname.trim().toLowerCase()
  return (policy.allowedHosts ?? []).some((allowed) => allowed.toLowerCase() === host)
}

/** 校验一个 URL 是否允许访问。通过时返回解析后的 URL 对象。 */
export async function assertUrlAllowed(input: string | URL, policy: SsrfPolicy = {}): Promise<URL> {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : input
  } catch {
    throw new SsrfBlockedError(`无法解析的 URL：${String(input)}`, String(input))
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`不支持的协议：${url.protocol}`, url.hostname)
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isAllowedHost(hostname, policy)) return url

  if (isBlockedHostname(hostname)) {
    throw new SsrfBlockedError(`禁止访问本地地址：${hostname}`, hostname)
  }

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(`禁止访问内网或保留地址：${hostname}`, hostname)
    }
    return url
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    // DNS 失败交给请求层处理，这里不吞掉真实原因
    return url
  }

  if (addresses.length === 0) return url

  const blocked = addresses.find((item) => isBlockedIp(item.address))
  if (blocked) {
    throw new SsrfBlockedError(
      `域名 ${hostname} 解析到内网地址 ${blocked.address}，已拒绝访问`,
      hostname,
    )
  }
  return url
}

/**
 * 生成带 SSRF 校验的 DNS lookup。
 *
 * Node 的 `lookup` 回调在建立连接时触发，因此这里拒绝的地址不会被真正连接，
 * 这是对 DNS rebinding 的有效防护。
 */
export function createGuardedLookup(policy: SsrfPolicy = {}): LookupFunction {
  return (hostname, options, callback) => {
    if (isBlockedHostname(hostname) && !isAllowedHost(hostname, policy)) {
      callback(new SsrfBlockedError(`禁止访问本地地址：${hostname}`, hostname), '', 4)
      return
    }

    dnsLookup(hostname, { ...options, all: true, verbatim: true })
      .then((addresses) => {
        const list = Array.isArray(addresses) ? addresses : []
        const bypass = isAllowedHost(hostname, policy)
        const blocked = bypass ? undefined : list.find((item) => isBlockedIp(item.address))
        if (blocked) {
          callback(
            new SsrfBlockedError(`域名 ${hostname} 解析到内网地址 ${blocked.address}，已拒绝连接`, hostname),
            '',
            4,
          )
          return
        }
        const first = list[0]
        if (!first) {
          callback(new SsrfBlockedError(`域名 ${hostname} 没有可用地址`, hostname), '', 4)
          return
        }
        if (options.all) {
          callback(null, list, first.family)
          return
        }
        callback(null, first.address, first.family)
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), '', 4)
      })
  }
}
