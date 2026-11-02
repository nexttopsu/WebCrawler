/**
 * 显式的 JSON 字段路径。
 *
 * 只支持一套可预测的语法，避免引入完整 JSONPath 实现的复杂度：
 * - `data.title`
 * - `data.items[0].url`
 * - `data.items[*].url`（`[*]` 只能出现在最后一段，返回数组）
 * - 允许以 `$` 开头
 *
 * 写法非法时抛 `ParserError`，而不是静默返回空值。
 */
import { ParserError, ParserErrorCode } from './errors.js'

interface PathToken {
  key: string | null
  index: number | 'all' | null
}

function parsePath(path: string): PathToken[] {
  const trimmed = path.trim().replace(/^\$\.?/, '')
  if (!trimmed) {
    throw new ParserError(ParserErrorCode.INVALID_JSON_PATH, `JSON 路径不能为空：${path}`)
  }

  const tokens: PathToken[] = []
  for (const segment of trimmed.split('.')) {
    if (!segment) {
      throw new ParserError(ParserErrorCode.INVALID_JSON_PATH, `JSON 路径包含空段：${path}`)
    }

    const match = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(segment)
    if (!match) {
      throw new ParserError(ParserErrorCode.INVALID_JSON_PATH, `JSON 路径写法不合法：${path}`)
    }

    const [, key = '', brackets = ''] = match
    const indexes = brackets ? brackets.match(/\[(\d+|\*)\]/g) ?? [] : []

    if (indexes.length > 1) {
      throw new ParserError(ParserErrorCode.INVALID_JSON_PATH, `JSON 路径不支持多维下标：${path}`)
    }

    const indexToken = indexes[0]
    tokens.push({
      key: key || null,
      index: indexToken ? (indexToken === '[*]' ? 'all' : Number(indexToken.slice(1, -1))) : null,
    })
  }

  return tokens
}

/** 读取 JSON 路径对应的值；不存在时返回 undefined。 */
export function getJsonPath(data: unknown, path: string): unknown {
  return walk(data, parsePath(path), 0)
}

function walk(current: unknown, tokens: PathToken[], index: number): unknown {
  if (index >= tokens.length) return current
  if (current === null || current === undefined) return undefined

  const token = tokens[index] as PathToken
  let value: unknown = current

  if (token.key !== null) {
    if (typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[token.key]
  }

  if (token.index === null) return walk(value, tokens, index + 1)
  if (!Array.isArray(value)) return undefined

  // [*]：对数组每一项继续求剩余路径
  if (token.index === 'all') {
    const rest = tokens.slice(index + 1)
    if (rest.length === 0) return value
    return value.map((item) => walk(item, rest, 0)).filter((item) => item !== undefined)
  }

  return walk(value[token.index], tokens, index + 1)
}

/** 把 JSON 值统一转成字符串；对象与数组序列化为 JSON。 */
export function jsonValueToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** 把 JSON 值统一转成字符串数组。 */
export function jsonValueToStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map(jsonValueToString).filter((item) => item !== '')
  const single = jsonValueToString(value)
  return single ? [single] : []
}
