/**
 * 字段提取引擎。
 *
 * 规则测试器（第四阶段）与正式采集共用这里的逻辑，确保「测出来的结果」
 * 与「跑任务得到的结果」完全一致。
 *
 * 返回值同时包含数据与诊断信息（匹配数量、缺失字段、错误），
 * 便于规则调试；单个字段失败不会中断整篇文章。
 */
import type { FieldRule, ValidateConfig } from '../../shared/index.js'
import { cleanText } from '../clean.js'
import { ParserError, ParserErrorCode } from '../errors.js'
import { getJsonPath, jsonValueToString, jsonValueToStringArray } from '../json-path.js'
import { selectWithin, type HtmlDocument, type MatchedNode } from './document.js'

const FIELD_TYPES = new Set(['text', 'html', 'attr', 'list', 'object'])

/** 字段值形态。 */
export type FieldValue = string | string[] | Record<string, unknown> | Record<string, unknown>[] | null

/** 单个字段的提取结果。 */
export interface FieldExtraction {
  key: string
  value: FieldValue
  /** 命中的节点数量 */
  matched: number
  /** 是否满足必填要求 */
  ok: boolean
  required: boolean
  /** 错误说明（必填缺失、选择器非法等） */
  error?: string
}

/** 一组字段的提取结果。 */
export interface ExtractionResult {
  /** 只含成功提取的值 */
  data: Record<string, unknown>
  /** 每个字段的完整诊断 */
  fields: Record<string, FieldExtraction>
  /** 必填但缺失的字段 */
  missing: string[]
  /** 字段级错误 */
  errors: string[]
}

/** 提取作用域：文档或某个节点。 */
export type ExtractScope = HtmlDocument | MatchedNode

function fail(key: string, rule: FieldRule, message: string): FieldExtraction {
  return {
    key,
    value: rule.defaultValue ?? '',
    matched: 0,
    ok: false,
    required: rule.required === true,
    error: message,
  }
}

/** 校验字段规则本身是否合法，规则加载时调用一次即可。 */
export function validateFieldRules(rules: Record<string, FieldRule>, prefix = ''): void {
  for (const [key, rule] of Object.entries(rules)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (!rule || typeof rule !== 'object') {
      throw new ParserError(ParserErrorCode.INVALID_FIELD_RULE, `字段 "${path}" 不是合法的规则对象`)
    }
    if (!FIELD_TYPES.has(rule.type)) {
      throw new ParserError(ParserErrorCode.INVALID_FIELD_RULE, `字段 "${path}" 的类型不支持：${String(rule.type)}`)
    }
    if (rule.type === 'attr' && !rule.attribute && !rule.jsonPath) {
      throw new ParserError(ParserErrorCode.INVALID_FIELD_RULE, `字段 "${path}" 为 attr 类型，但缺少 attribute`)
    }
    if ((rule.type === 'list' || rule.type === 'object') && (!rule.fields || Object.keys(rule.fields).length === 0)) {
      throw new ParserError(ParserErrorCode.INVALID_FIELD_RULE, `字段 "${path}" 为 ${rule.type} 类型，但缺少 fields`)
    }
    if (rule.fields) validateFieldRules(rule.fields, path)
  }
}

function isEmpty(value: FieldValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return Object.keys(value).length === 0
}

function clean(value: string, rule: FieldRule): string {
  return cleanText(value, rule.clean ?? {})
}

/** 提取单个字段。 */
function extractField(scope: ExtractScope, key: string, rule: FieldRule, required: boolean): FieldExtraction {
  const selectorType = rule.selectorType ?? 'css'
  const selector = rule.selector?.trim()

  if (rule.jsonPath) {
    return fail(key, rule, `字段 "${key}" 使用了 jsonPath，但当前是 HTML 提取模式`)
  }

  // 无选择器：作用于当前作用域节点自身
  if (!selector) {
    if (!('text' in scope)) {
      const message = `字段 "${key}" 缺少 selector（在文档根作用域下必须指定选择器）`
      return fail(key, rule, message)
    }

    switch (rule.type) {
      case 'text': {
        const value = clean(scope.text(), rule)
        return { key, value, matched: 1, ok: !isEmpty(value) || required === false, required }
      }
      case 'html': {
        const value = scope.html()
        return { key, value, matched: 1, ok: value !== '' || required === false, required }
      }
      case 'attr': {
        const value = clean(scope.attr(rule.attribute ?? '') ?? '', rule)
        return { key, value, matched: value ? 1 : 0, ok: value !== '', required }
      }
      case 'object': {
        const nested = extractFields(scope, rule.fields ?? {})
        const value = nested.data
        return { key, value, matched: 1, ok: Object.keys(value).length > 0, required }
      }
      default:
        return fail(key, rule, `字段 "${key}" 的 list 类型必须提供 selector`)
    }
  }

  let nodes: MatchedNode[]
  try {
    nodes = selectWithin(scope, selector, selectorType)
  } catch (error) {
    return fail(key, rule, error instanceof Error ? error.message : String(error))
  }

  const matched = nodes.length

  if (rule.type === 'list') {
    if (!rule.fields) return fail(key, rule, `字段 "${key}" 的 list 类型缺少 fields`)
    const items: Record<string, unknown>[] = nodes.map((node) => extractFields(node, rule.fields ?? {}).data)
    return { key, value: items, matched, ok: items.length > 0, required }
  }

  if (rule.type === 'object') {
    const first = nodes[0]
    if (!first) return { key, value: {}, matched: 0, ok: false, required }
    const nested = extractFields(first, rule.fields ?? {})
    return { key, value: nested.data, matched, ok: Object.keys(nested.data).length > 0, required }
  }

  const values = nodes.map((node) => {
    if (rule.type === 'html') return node.html()
    if (rule.type === 'attr') return clean(node.attr(rule.attribute ?? '') ?? '', rule)
    return clean(node.text(), rule)
  })

  if (rule.multiple) {
    const filtered = values.filter((item) => item.trim() !== '')
    return { key, value: filtered, matched, ok: filtered.length > 0, required }
  }

  const first = values[0] ?? ''
  return { key, value: first, matched, ok: first.trim() !== '' || !required, required }
}

/** 提取一组字段。 */
export function extractFields(
  scope: ExtractScope,
  rules: Record<string, FieldRule>,
  validate: ValidateConfig = {},
): ExtractionResult {
  const data: Record<string, unknown> = {}
  const fields: Record<string, FieldExtraction> = {}
  const missing: string[] = []
  const errors: string[] = []

  const requiredFields = new Set(validate.requiredFields ?? [])

  for (const [key, rule] of Object.entries(rules)) {
    const required = rule.required === true || requiredFields.has(key)
    let result = extractField(scope, key, rule, required)

    // 缺失时应用默认值
    if (isEmpty(result.value) && rule.defaultValue !== undefined) {
      result = {
        ...result,
        value: rule.multiple || rule.type === 'list' ? [rule.defaultValue] : rule.defaultValue,
        ok: true,
      }
    }

    if (isEmpty(result.value)) {
      result.ok = false
      if (required) {
        missing.push(key)
        result.error ??= `必填字段 "${key}" 未匹配到内容`
      }
    } else {
      result.ok = true
      result.error = undefined
    }

    if (result.error) errors.push(result.error)
    fields[key] = result
    if (result.value !== null && !isEmpty(result.value)) {
      data[key] = result.value
    }
  }

  return { data, fields, missing, errors }
}

/** JSON 响应模式下的字段提取。 */
export function extractJsonFields(
  json: unknown,
  rules: Record<string, FieldRule>,
  validate: ValidateConfig = {},
): ExtractionResult {
  const data: Record<string, unknown> = {}
  const fields: Record<string, FieldExtraction> = {}
  const missing: string[] = []
  const errors: string[] = []
  const requiredFields = new Set(validate.requiredFields ?? [])

  for (const [key, rule] of Object.entries(rules)) {
    const required = rule.required === true || requiredFields.has(key)
    if (!rule.jsonPath) {
      const message = `字段 "${key}" 在 JSON 模式下必须提供 jsonPath`
      fields[key] = fail(key, rule, message)
      errors.push(message)
      if (required) missing.push(key)
      continue
    }

    let raw: unknown
    try {
      raw = getJsonPath(json, rule.jsonPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fields[key] = fail(key, rule, message)
      errors.push(message)
      if (required) missing.push(key)
      continue
    }

    let value: FieldValue
    if (rule.multiple) {
      value = jsonValueToStringArray(raw).map((item) => clean(item, rule))
    } else {
      value = clean(jsonValueToString(raw), rule)
    }

    if (isEmpty(value) && rule.defaultValue !== undefined) {
      value = rule.multiple ? [rule.defaultValue] : rule.defaultValue
    }

    if (isEmpty(value)) {
      const message = required ? `必填字段 "${key}" 在 JSON 中不存在` : ''
      fields[key] = { key, value, matched: 0, ok: false, required, ...(message ? { error: message } : {}) }
      if (required) missing.push(key)
      if (message) errors.push(message)
      continue
    }

    fields[key] = { key, value, matched: 1, ok: true, required }
    data[key] = value
  }

  return { data, fields, missing, errors }
}
