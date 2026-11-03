/**
 * 统一解析入口。
 *
 * 对外只暴露这一个 Parser：CSS / XPath / JSON 三种能力都从这里进入，
 * 规则测试器与正式采集必须共用它，禁止各自实现一套提取逻辑。
 */
import type { FieldCleanRule, FieldRule, SelectorType, ValidateConfig } from '../../shared/index.js'
import { cleanHtml, cleanText, extractImages, htmlToText, type CleanHtmlOptions } from '../clean.js'
import { ParserError, ParserErrorCode } from '../errors.js'
import { getJsonPath } from '../json-path.js'
import { normalizeUrl, resolveUrl, type NormalizeUrlOptions } from '../url.js'
import { parseDocument, selectWithin, type HtmlDocument, type MatchedNode } from './document.js'
import {
  extractFields,
  extractJsonFields,
  validateFieldRules,
  type ExtractionResult,
  type FieldValue,
} from './extract.js'

/** 单值 / 多值提取选项。 */
export interface ExtractOptions {
  /** 选择器类型，默认 css */
  selectorType?: SelectorType
  /** 是否取全部匹配 */
  multiple?: boolean
  /** 取值后的清洗规则 */
  clean?: FieldCleanRule
}

/** 解析器。 */
export class Parser {
  /** 解析 HTML 为可查询的文档。 */
  parseHtml(html: string): HtmlDocument {
    return parseDocument(html ?? '')
  }

  /** 解析 JSON 文本，非法 JSON 抛 ParserError。 */
  parseJson<T = unknown>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new ParserError(
        ParserErrorCode.PARSE_FAILED,
        `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 统计选择器匹配数量。 */
  count(html: string | HtmlDocument, selector: string, selectorType: SelectorType = 'css'): number {
    const doc = this.toDocument(html)
    return doc.count(selector, selectorType)
  }

  /** 提取文本。 */
  extractText(
    html: string | HtmlDocument,
    selector: string,
    options: ExtractOptions = {},
  ): string | string[] {
    return this.extractByType(html, selector, 'text', options)
  }

  /** 提取 innerHTML。 */
  extractHtml(
    html: string | HtmlDocument,
    selector: string,
    options: ExtractOptions = {},
  ): string | string[] {
    return this.extractByType(html, selector, 'html', options)
  }

  /** 提取属性值。 */
  extractAttribute(
    html: string | HtmlDocument,
    selector: string,
    attribute: string,
    options: ExtractOptions = {},
  ): string | string[] {
    const doc = this.toDocument(html)
    const nodes = doc.selectAll(selector, options.selectorType ?? 'css')
    const values = nodes
      .map((node) => cleanText(node.attr(attribute) ?? '', options.clean ?? {}))
      .filter((value) => value !== '')
    return options.multiple ? values : (values[0] ?? '')
  }

  /** 提取列表：每个匹配项作为一条记录。 */
  extractList(
    html: string | HtmlDocument,
    itemSelector: string,
    fields: Record<string, FieldRule>,
    options: { selectorType?: SelectorType } = {},
  ): Record<string, unknown>[] {
    validateFieldRules(fields)
    const doc = this.toDocument(html)
    return doc
      .selectAll(itemSelector, options.selectorType ?? 'css')
      .map((node) => extractFields(node, fields).data)
  }

  /** 提取嵌套对象。 */
  extractObject(
    html: string | HtmlDocument,
    fields: Record<string, FieldRule>,
    options: { selector?: string; selectorType?: SelectorType } = {},
  ): Record<string, unknown> {
    validateFieldRules(fields)
    const doc = this.toDocument(html)
    if (!options.selector) return extractFields(doc, fields).data
    const node = doc.selectFirst(options.selector, options.selectorType ?? 'css')
    return node ? extractFields(node, fields).data : {}
  }

  /** 按字段规则提取整组字段（HTML 模式）。 */
  extractFields(
    html: string | HtmlDocument,
    fields: Record<string, FieldRule>,
    validate: ValidateConfig = {},
  ): ExtractionResult {
    validateFieldRules(fields)
    const doc = this.toDocument(html)
    return extractFields(doc, fields, validate)
  }

  /** 按字段规则提取整组字段（JSON 模式）。 */
  extractJsonFields(
    json: unknown,
    fields: Record<string, FieldRule>,
    validate: ValidateConfig = {},
  ): ExtractionResult {
    validateFieldRules(fields)
    return extractJsonFields(json, fields, validate)
  }

  /** 读取 JSON 路径。 */
  extractJsonPath(json: unknown, path: string): unknown {
    return getJsonPath(json, path)
  }

  /** 文本清洗。 */
  cleanText(input: string | null | undefined, rule: FieldCleanRule = {}): string {
    return cleanText(input, rule)
  }

  /** HTML 清洗（移除脚本、事件属性、危险协议）。 */
  cleanHtml(input: string | null | undefined, options: CleanHtmlOptions = {}): string {
    return cleanHtml(input, options)
  }

  /** HTML 转纯文本。 */
  htmlToText(input: string | null | undefined): string {
    return htmlToText(input)
  }

  /** 从 HTML 中提取图片并转绝对地址。 */
  extractImages(input: string, baseUrl?: string): string[] {
    return extractImages(input, (value) => resolveUrl(value, baseUrl))
  }

  /** 相对地址转绝对地址。 */
  resolveUrl(href: string, base?: string): string {
    return resolveUrl(href, base)
  }

  /** URL 规范化。 */
  normalizeUrl(url: string, options?: NormalizeUrlOptions): string {
    return normalizeUrl(url, options)
  }

  /** 在节点作用域内查询，供插件复用。 */
  selectWithin(scope: HtmlDocument | MatchedNode, expr: string, type: SelectorType = 'css'): MatchedNode[] {
    return selectWithin(scope, expr, type)
  }

  private toDocument(html: string | HtmlDocument): HtmlDocument {
    return typeof html === 'string' ? parseDocument(html) : html
  }

  private extractByType(
    html: string | HtmlDocument,
    selector: string,
    type: 'text' | 'html',
    options: ExtractOptions,
  ): string | string[] {
    const doc = this.toDocument(html)
    const nodes = doc.selectAll(selector, options.selectorType ?? 'css')
    const values = nodes
      .map((node) =>
        type === 'text' ? cleanText(node.text(), options.clean ?? {}) : node.html(),
      )
      .filter((value) => value.trim() !== '')

    const result: FieldValue = options.multiple ? values : (values[0] ?? '')
    return result as string | string[]
  }
}

/** 创建解析器。 */
export function createParser(): Parser {
  return new Parser()
}
