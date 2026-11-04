/**
 * 文档模型：把 HTML 统一到 `HtmlDocument` / `MatchedNode` 抽象。
 *
 * 只有 CSS 一个适配器：cheerio（css-select 完整实现，支持属性、伪类、组合选择器）。
 * 插件、规则提取、规则测试器都从这里拿文档，禁止各自 `load()` HTML。
 */
import { load, type Cheerio, type CheerioAPI } from 'cheerio'
import { ParserError, ParserErrorCode } from '../errors.js'

/** cheerio 的节点类型（避免直接依赖 domhandler）。 */
type CheerioNode = ReturnType<CheerioAPI> extends Cheerio<infer T> ? T : never

/** 统一后的匹配节点。 */
export interface MatchedNode {
  /** 节点内全部文本（含子孙） */
  text(): string
  /** 节点内部 HTML */
  html(): string
  /** 节点自身 HTML */
  outerHtml(): string
  /** 属性值 */
  attr(name: string): string | undefined
  /** 在该节点作用域内继续查询 */
  findAll(expr: string): MatchedNode[]
}

/** 统一后的文档。 */
export interface HtmlDocument {
  /** 原始 HTML */
  readonly source: string
  selectAll(expr: string): MatchedNode[]
  selectFirst(expr: string): MatchedNode | null
  /** 匹配数量，用于规则校验 */
  count(expr: string): number
  /** 删除匹配节点，返回删除数量 */
  remove(selectors: string[]): number
  /** 当前（可能已被清洗）的 HTML */
  serialize(): string
}

class CheerioNodeWrapper implements MatchedNode {
  constructor(
    private readonly api: CheerioAPI,
    private readonly element: CheerioNode,
  ) {}

  text(): string {
    return this.api(this.element).text()
  }

  html(): string {
    return this.api(this.element).html() ?? ''
  }

  outerHtml(): string {
    return this.api.html(this.element)
  }

  attr(name: string): string | undefined {
    const value = this.api(this.element).attr(name)
    return value === undefined ? undefined : value
  }

  findAll(expr: string): MatchedNode[] {
    try {
      return this.api(this.element)
        .find(expr)
        .toArray()
        .map((node) => new CheerioNodeWrapper(this.api, node))
    } catch (error) {
      throw new ParserError(
        ParserErrorCode.INVALID_SELECTOR,
        `CSS 选择器不合法：${expr}（${error instanceof Error ? error.message : String(error)}）`,
        { expression: expr },
      )
    }
  }
}

/** 基于 cheerio 的文档实现。 */
export class CheerioDocument implements HtmlDocument {
  readonly source: string
  private readonly api: CheerioAPI

  constructor(html: string) {
    this.source = html
    try {
      this.api = load(html)
    } catch (error) {
      throw new ParserError(
        ParserErrorCode.PARSE_FAILED,
        `HTML 解析失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  get $(): CheerioAPI {
    return this.api
  }

  selectAll(expr: string): MatchedNode[] {
    try {
      return this.api(expr)
        .toArray()
        .map((node) => new CheerioNodeWrapper(this.api, node))
    } catch (error) {
      throw new ParserError(
        ParserErrorCode.INVALID_SELECTOR,
        `CSS 选择器不合法：${expr}（${error instanceof Error ? error.message : String(error)}）`,
        { expression: expr },
      )
    }
  }

  selectFirst(expr: string): MatchedNode | null {
    return this.selectAll(expr)[0] ?? null
  }

  count(expr: string): number {
    return this.selectAll(expr).length
  }

  remove(selectors: string[]): number {
    let removed = 0
    for (const selector of selectors) {
      if (!selector.trim()) continue
      try {
        const selection = this.api(selector)
        removed += selection.length
        selection.remove()
      } catch (error) {
        throw new ParserError(
          ParserErrorCode.INVALID_SELECTOR,
          `清洗选择器不合法：${selector}（${error instanceof Error ? error.message : String(error)}）`,
          { expression: selector },
        )
      }
    }
    return removed
  }

  serialize(): string {
    return this.api.html()
  }
}

/** 解析 HTML，得到统一文档。 */
export function parseDocument(html: string): HtmlDocument {
  return new CheerioDocument(html ?? '')
}

/** 在文档或节点作用域内查询。 */
export function selectWithin(scope: HtmlDocument | MatchedNode, expr: string): MatchedNode[] {
  if ('findAll' in scope) return scope.findAll(expr)
  return scope.selectAll(expr)
}
