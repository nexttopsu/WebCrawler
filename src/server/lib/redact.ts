/**
 * 日志与错误响应脱敏。
 *
 * 两类信息必须处理：
 * - URL：查询参数里可能带 token / signature / session；URL 自身的 userinfo 可能带密码。
 * - 结构化字段：headers、代理配置、请求体中的密码与 Cookie。
 *
 * 策略保守：只要参数名命中敏感词就替换为 `***`，宁可丢排查信息也不落库明文。
 */

const SENSITIVE_QUERY_KEYS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'client_secret',
  'signature',
  'sig',
  'session',
  'sessionid',
  'session_id',
  'cookie',
  'ticket',
  'key',
]

const SENSITIVE_FIELD_PATTERN =
  /(password|passwd|pwd|secret|token|authorization|cookie|credential|apikey|api_key|private_key)/i

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
])

const MASK = '***'

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase()
  if (SENSITIVE_QUERY_KEYS.includes(normalized)) return true
  return SENSITIVE_FIELD_PATTERN.test(normalized)
}

/**
 * 脱敏 URL。
 *
 * 保持协议、主机、路径、参数名与顺序，只替换敏感参数的值；
 * 无法解析时退化为正则替换，仍然不会把 `token=...` 原样留下。
 */
export function redactUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
      .replace(/([?&](?:token|access_token|password|secret|signature|key)=)[^&#]*/gi, `$1${MASK}`)
      .replace(/\/\/[^/@\s]+@/, `//${MASK}@`)
  }

  if (url.username || url.password) {
    url.username = MASK
    url.password = ''
  }

  let changed = false
  for (const key of [...url.searchParams.keys()]) {
    if (!isSensitiveKey(key)) continue
    url.searchParams.set(key, MASK)
    changed = true
  }
  return changed ? url.toString() : value
}

/** 脱敏请求头：返回新对象，不修改入参。 */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | null {
  if (!headers) return null
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    output[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? MASK : value
  }
  return output
}

/**
 * 深度脱敏任意值，用于日志 detail 与错误 details。
 *
 * 最多下探 6 层，超出部分整体替换为 `'[depth-limit]'`，
 * 避免异常对象（循环引用已在更早处被 JSON.stringify 处理）拖垮日志写入。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (depth > 6) return '[depth-limit]'

  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1))
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? MASK : redactValue(entry, depth + 1)
  }
  return output
}

/** 文本脱敏：处理 `Bearer xxx` 与 `token=xxx` 这类内联凭据。 */
export function redactText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${MASK}`)
    .replace(
      /((?:password|passwd|token|secret|signature|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      `$1${MASK}`,
    )
}
