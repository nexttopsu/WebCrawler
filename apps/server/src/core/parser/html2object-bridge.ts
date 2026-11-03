/**
 * request-pack `html2object` 桥接层。
 *
 * 把规则里的字段配置（`FieldRule`）编译成 request-pack 的 schema
 * （`text` / `html` / `attr` / `object` / `loop`），一次解析整篇 HTML；
 * `jsonPath` 与 XPath 字段 html2object 表达不了，回退到内置提取器处理。
 *
 * 输出与 `extract.ts` 的 `ExtractionResult` 同构：规则测试器与正式采集
 * 共用同一份诊断结构。
 */
import {
  attr as rpAttr,
  html2object as rpHtml2Object,
  html as rpHtml,
  loop as rpLoop,
  nullable as rpNullable,
  object as rpObject,
  text as rpText,
  type Field as RpField,
  type Schema as RpSchema,
} from 'request-pack'
import type { FieldRule, ValidateConfig } from '../../shared/index.js'
import { cleanText } from '../clean.js'
import { parseDocument, type HtmlDocument, type MatchedNode } from './document.js'
import { extractFields as legacyExtractFields, type ExtractionResult, type FieldExtraction, type FieldValue } from './extract.js'

/** request-pack 的 object 组合器不接受泛型参数以外的形状，这里统一收窄。 */
type RpSchemaField = RpField

/** 判断字段能否编译成 request-pack schema（CSS + 内置组合器可表达的子集）。 */
function isRpCompatible(rule: FieldRule): boolean {
  if (rule.jsonPath) return false
  if (rule.selectorType === 'xpath') return false
  if (rule.type === 'attr' && !rule.attribute) return false
  if ((rule.type === 'object' || rule.type === 'list') && !rule.fields) return false
  return true
}

/** 编译单个字段；不可表达时返回 null（由回退路径处理）。 */
function buildField(rule: FieldRule): RpSchemaField | null {
  const selector = rule.selector?.trim() ?? ''
  switch (rule.type) {
    case 'text':
      return rule.multiple
        ? rpLoop(selector, rpText(''))
        : rpNullable(rpText(selector, { first: true }))
    case 'html':
      return rule.multiple
        ? rpLoop(selector, rpHtml(''))
        : rpNullable(rpHtml(selector, { first: true }))
    case 'attr': {
      if (!rule.attribute) return null
      return rule.multiple
        ? rpLoop(selector, rpAttr(rule.attribute))
        : rpNullable(rpAttr(rule.attribute, selector || undefined))
    }
    case 'object': {
      const nested = buildSchema(rule.fields ?? {})
      if (!nested) return null
      return selector ? rpObject(selector, nested) : rpObject(nested)
    }
    case 'list': {
      const nested = buildSchema(rule.fields ?? {})
      if (!nested) return null
      return rpLoop(selector, nested)
    }
    default:
      return null
  }
}

/** 编译一组字段；任一字段不可表达时返回 null（整组走回退路径）。 */
function buildSchema(rules: Record<string, FieldRule>): RpSchema | null {
  const schema: RpSchema = {}
  for (const [key, rule] of Object.entries(rules)) {
    const field = buildField(rule)
    if (!field) return null
    schema[key] = field
  }
  return Object.keys(schema).length > 0 ? schema : null
}

function isEmptyValue(value: FieldValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/** 按字段规则清洗提取值（字符串 / 字符串数组 / 嵌套对象与数组递归）。 */
function applyClean(rule: FieldRule, value: FieldValue): FieldValue {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return cleanText(value, rule.clean ?? {})
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'string' ? cleanText(item, rule.clean ?? {}) : applyClean(rule, item as FieldValue),
    ) as FieldValue
  }
  if (rule.fields && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const nested = rule.fields[key]
      result[key] = nested ? applyClean(nested, item as FieldValue) : item
    }
    return result as FieldValue
  }
  return value
}

/** 统计选择器在文档中的命中数量（供测试器展示）。 */
function countMatches(doc: HtmlDocument, rule: FieldRule): number {
  const selector = rule.selector?.trim()
  if (!selector) return 1
  try {
    return doc.selectAll(selector, 'css').length
  } catch {
    return 0
  }
}

function extractSingleRpField(
  doc: HtmlDocument,
  key: string,
  rule: FieldRule,
  raw: FieldValue,
  required: boolean,
): FieldExtraction {
  let value = applyClean(rule, raw)

  // 未命中时应用默认值（与内置提取器语义一致）
  if (isEmptyValue(value) && rule.defaultValue !== undefined) {
    value = rule.multiple || rule.type === 'list' ? [rule.defaultValue] : rule.defaultValue
  }

  const empty = isEmptyValue(value)
  const matched = empty ? 0 : Array.isArray(value) ? value.length : countMatches(doc, rule)

  if (empty) {
    const extraction: FieldExtraction = { key, value: null, matched: 0, ok: !required, required }
    if (required) extraction.error = `必填字段 "${key}" 未匹配到内容`
    return extraction
  }

  return { key, value, matched: Math.max(matched, 1), ok: true, required }
}

/**
 * 用 request-pack `html2object` 提取一组字段。
 *
 * - CSS 且可编译的字段：一次 `html2object` 调用整体解析；
 * - `jsonPath` 或 XPath 字段：回退到内置提取器（与 JSON 模式同一实现）。
 */
export function extractFieldsViaHtml2Object(
  html: string,
  rules: Record<string, FieldRule>,
  validate: ValidateConfig = {},
): ExtractionResult {
  const doc = parseDocument(html ?? '')
  const requiredFields = new Set(validate.requiredFields ?? [])

  const rpRules: Record<string, FieldRule> = {}
  const legacyRules: Record<string, FieldRule> = {}
  for (const [key, rule] of Object.entries(rules)) {
    if (isRpCompatible(rule)) rpRules[key] = rule
    else legacyRules[key] = rule
  }

  const data: Record<string, unknown> = {}
  const fields: Record<string, FieldExtraction> = {}
  const missing: string[] = []
  const errors: string[] = []

  // 1. request-pack 路径：一次编译、一次解析
  const schema = buildSchema(rpRules)
  let raw: Record<string, unknown> = {}
  if (schema) {
    try {
      raw = rpHtml2Object(html ?? '', schema) as Record<string, unknown>
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`html2object 解析失败：${message}`)
    }
  }

  for (const [key, rule] of Object.entries(rpRules)) {
    const required = rule.required === true || requiredFields.has(key)
    const extraction = extractSingleRpField(doc, key, rule, (raw[key] ?? null) as FieldValue, required)
    if (extraction.error) errors.push(extraction.error)
    if (!extraction.ok) missing.push(key)
    fields[key] = extraction
    if (extraction.value !== null && !isEmptyValue(extraction.value as FieldValue)) {
      data[key] = extraction.value
    }
  }

  // 2. 回退路径：jsonPath / XPath 字段交给内置提取器
  if (Object.keys(legacyRules).length > 0) {
    const legacy = legacyExtractFields(doc, legacyRules, validate)
    for (const [key, extraction] of Object.entries(legacy.fields)) {
      if (fields[key]) continue
      fields[key] = extraction
      if (extraction.ok && extraction.value !== null && !isEmptyValue(extraction.value as FieldValue)) {
        data[key] = extraction.value
      }
    }
    for (const [key, value] of Object.entries(legacy.data)) {
      if (!(key in data)) data[key] = value
    }
    missing.push(...legacy.missing.filter((key) => !missing.includes(key)))
    errors.push(...legacy.errors)
  }

  return { data, fields, missing, errors }
}

/**
 * 把列表字段配置编译成 `loop(itemSelector, fields)` 并提取全部列表项。
 *
 * 返回原始对象数组（未做 URL 归一化），调用方（引擎）负责绝对地址、
 * 去重与 ArticleLink 组装。itemSelectorType=xpath 或字段含 jsonPath 时
 * 回退到内置提取器逐项解析。
 */
export function extractListItems(
  html: string,
  itemSelector: string,
  itemSelectorType: 'css' | 'xpath' | undefined,
  fields: Record<string, FieldRule>,
): Record<string, unknown>[] {
  const allCompatible = Object.values(fields).every((rule) => isRpCompatible(rule))
  if (allCompatible && (itemSelectorType ?? 'css') === 'css') {
    const schema = buildSchema(fields)
    if (schema) {
      const raw = rpHtml2Object(html ?? '', { items: rpLoop(itemSelector, schema) }) as {
        items?: unknown
      }
      return Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : []
    }
  }

  // 回退：XPath 容器或含 jsonPath 字段 → 内置提取器逐项解析
  const doc = parseDocument(html ?? '')
  const nodes: MatchedNode[] = doc.selectAll(itemSelector, itemSelectorType ?? 'css')
  return nodes.map((node) => legacyExtractFields(node, fields).data)
}
