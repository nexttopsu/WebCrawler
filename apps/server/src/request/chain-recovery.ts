/**
 * TLS 链自动补全（AIA）。
 *
 * 背景：不少网站部署 HTTPS 时漏配中间证书（只发叶子证书），Node 只信任内置
 * CA 列表且不会像浏览器那样按 AIA 自动下载缺失的中间证书，于是直接报
 * `unable to verify the first certificate`（UNABLE_TO_VERIFY_LEAF_SIGNATURE）。
 *
 * 这里的策略与浏览器一致，且**不放松证书校验**：
 * 1. 从错误码识别出「链不完整」类失败；
 * 2. 另起一次 TLS 握手拿叶子证书（仅读证书，不发送业务请求）；
 * 3. 解析叶子证书的 AIA 扩展，下载 `caIssuers` 指向的中间证书；
 * 4. 把下载到的中间证书作为 `ca` 重试原请求 —— 最终校验仍然完整执行，
 *    下载内容无效时重试同样失败，原始错误照常抛出。
 */

import { connect as tlsConnect } from 'node:tls'
import { assertUrlAllowed, createGuardedLookup, type SsrfPolicy } from './ssrf-guard.js'

/** 表示「信任链缺证书」的 Node TLS 错误码。 */
const CHAIN_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
])

/** 沿 cause 链找「链不完整」类 TLS 错误（axios 会把 TLS 错误包进 cause）。 */
export function isIncompleteChainError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string' && CHAIN_ERROR_CODES.has(candidate.code)) return true
    current = candidate.cause
  }
  return false
}

/** AIA 扩展 OID：1.3.6.1.5.5.7.1.1 */
const AIA_OID = Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01])
/** caIssuers 访问方式 OID：1.3.6.1.5.5.7.48.2 */
const CA_ISSUERS_OID = Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02])

/** GeneralName 的 [6] IMPLICIT IA5String（URI）标签。 */
const GENERAL_NAME_URI_TAG = 0x86

/** 单个 AIA 扫描窗口：扩展值不会离 OID 太远。 */
const AIA_SCAN_WINDOW = 512

/** 下载中间证书的大小上限。 */
const MAX_ISSUER_CERT_BYTES = 512 * 1024

/** 解析 DER 长度字段，返回内容长度与内容起始偏移。 */
function readDerLength(buf: Buffer, offset: number): { length: number; valueOffset: number } {
  const first = buf[offset]
  if (first === undefined) return { length: 0, valueOffset: offset }
  if ((first & 0x80) === 0) return { length: first, valueOffset: offset + 1 }
  const count = first & 0x7f
  if (count === 0 || count > 4) return { length: 0, valueOffset: offset + 1 }
  let length = 0
  for (let i = 1; i <= count; i += 1) length = length * 256 + (buf[offset + i] ?? 0)
  return { length, valueOffset: offset + 1 + count }
}

/**
 * 从叶子证书 DER 中解析 AIA 里的 caIssuers 地址。
 *
 * 采用定位 OID 后的小窗口扫描：不完整解析 ASN.1 树，只依赖
 * 「caIssuers OID 之后紧跟 [6] URI」这一结构事实，对常见证书足够稳健。
 */
export function parseAiaIssuerUrls(der: Buffer): string[] {
  const urls: string[] = []
  let pos = der.indexOf(AIA_OID)
  while (pos !== -1) {
    const window = der.subarray(pos + AIA_OID.length, pos + AIA_OID.length + AIA_SCAN_WINDOW)
    let inner = window.indexOf(CA_ISSUERS_OID)
    while (inner !== -1) {
      const tagOffset = inner + CA_ISSUERS_OID.length
      if (window[tagOffset] === GENERAL_NAME_URI_TAG) {
        const { length, valueOffset } = readDerLength(window, tagOffset + 1)
        if (length > 0 && valueOffset + length <= window.length) {
          const url = window.subarray(valueOffset, valueOffset + length).toString('latin1')
          if (/^https?:\/\//i.test(url)) urls.push(url)
        }
      }
      inner = window.indexOf(CA_ISSUERS_OID, tagOffset)
    }
    pos = der.indexOf(AIA_OID, pos + AIA_OID.length)
  }
  return [...new Set(urls)]
}

/** 把 DER 或 PEM 形式的证书统一成 PEM 字符串；内容不合法时返回 null。 */
export function encodeCertificatePem(data: Buffer): string | null {
  if (data.subarray(0, 27).toString('latin1') === '-----BEGIN CERTIFICATE-----') {
    const text = data.toString('latin1')
    return text.includes('-----END CERTIFICATE-----') ? text : null
  }
  if (data.length === 0 || data[0] !== 0x30) return null
  const body = data.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

/**
 * 与目标主机做一次只读 TLS 握手，取回叶子证书 DER。
 *
 * `rejectUnauthorized: false` 仅用于读取证书本身；不带任何业务语义。
 * DNS 仍走 SSRF 守卫的 lookup。
 */
export async function probeLeafCertificate(url: string, ssrf: SsrfPolicy): Promise<Buffer | null> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.protocol !== 'https:') return null

  return new Promise<Buffer | null>((resolve) => {
    const socket = tlsConnect({
      host: target.hostname,
      port: Number(target.port) || 443,
      servername: target.hostname,
      rejectUnauthorized: false,
      lookup: createGuardedLookup(ssrf),
    })
    const finish = (value: Buffer | null): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(8_000, () => finish(null))
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      finish(cert?.raw ? Buffer.from(cert.raw) : null)
    })
    socket.once('error', () => finish(null))
  })
}

/** 下载 AIA 指向的中间证书（最多前 3 个地址），返回 PEM 列表。 */
export async function fetchIssuerCertificates(
  urls: string[],
  ssrf: SsrfPolicy,
): Promise<string[]> {
  const pems: string[] = []
  for (const url of urls.slice(0, 3)) {
    try {
      // AIA 地址来自对方证书，同样要过 SSRF 校验
      await assertUrlAllowed(url, ssrf)
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > MAX_ISSUER_CERT_BYTES) continue
      const pem = encodeCertificatePem(buffer)
      if (pem) pems.push(pem)
    } catch {
      // 单个 Issuer 地址失败不影响其他候选；全部失败时由调用方回退原始错误
    }
  }
  return pems
}
