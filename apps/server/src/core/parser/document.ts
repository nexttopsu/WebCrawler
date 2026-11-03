/**
 * 文档模型：把 CSS 与 XPath 统一到同一个 `HtmlDocument` / `MatchedNode` 抽象。
 *
 * 为什么用两个解析器：
 * - CSS 使用 cheerio（css-select 完整实现，支持属性、伪类、组合选择器）；
 * - XPath 使用 linkedom + `xpath`，并且必须开启 `allowAnyNamespaceForNoPrefix`，
 *   否则 HTML 的 XHTML 命名空间会让 `//div` 一条都匹配不到。
 *
 * 两者都从同一份 HTML 字符串解析，结构一致；跨适配器的嵌套查询（在 XPath 作用域里用 CSS）
 * 通过序列化子树后重新解析实现，不做脆弱的节点映射。
 */
import { load, type Cheerio, type CheerioAPI } from 'cheerio'
import { parseHTML } from 'linkedom'
import * as xpath from 'xpath'
import type { SelectorType } from '../../shared/index.js'
import { ParserError, ParserErrorCode } from '../errors.js'

/** cheerio 的节点类型（避免直接依赖 domhandler）。 */
type CheerioNode = ReturnType<CheerioAPI> extends Cheerio<infer T> ? T : never

/** linkedom 节点在本模块内用到的最小结构。 */
interface DomNode {
  nodeType?: number
  textContent?: string | null
  /** 属性节点的值（`//a/@href` 命中的是 Attr 节点） */
  value?: string
  innerHTML?: string
  outerHTML?: string
  getAttribute?: (name: string) => string | null
}

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
  findAll(expr: string, type?: SelectorType): MatchedNode[]
}

/** 统一后的文档。 */
export interface HtmlDocument {
  /** 原始 HTML */
  readonly source: string
  selectAll(expr: string, type?: SelectorType): MatchedNode[]
  selectFirst(expr: string, type?: SelectorType): MatchedNode | null
  /** 匹配数量，用于规则校验 */
  count(expr: string, type?: SelectorType): number
  /** 删除匹配节点，返回删除数量 */
  remove(selectors: string[]): number
  /** 当前（可能已被清洗）的 HTML */
  serialize(): string
}

const XPATH_OPTIONS = { allowAnyNamespaceForNoPrefix: true } as const

function isXPath(type: SelectorType | undefined): boolean {
  return type === 'xpath'
}

/** 执行 XPath 查询，语法错误转成 ParserError。 */
function xpathSelect(context: unknown, expression: string): DomNode[] {
  if (!expression.trim()) {
    throw new ParserError(ParserErrorCode.INVALID_SELECTOR, 'XPath 表达式不能为空')
  }
  try {
    const parsed = xpath.parse(expression)
    const nodes = parsed.select({ ...XPATH_OPTIONS, node: context as Node })
    return nodes as unknown as DomNode[]
  } catch (error) {
    throw new ParserError(
      ParserErrorCode.INVALID_SELECTOR,
      `XPath 表达式不合法：${expression}（${error instanceof Error ? error.message : String(error)}）`,
      { expression },
    )
  }
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

  findAll(expr: string, type: SelectorType = 'css'): MatchedNode[] {
    if (type === 'css') {
      return this.api(this.element)
        .find(expr)
        .toArray()
        .map((node) => new CheerioNodeWrapper(this.api, node))
    }
    // 跨适配器：把子树序列化后按 XPath 重新解析
    return new CheerioDocument(this.outerHtml()).selectAll(expr, 'xpath')
  }
}

class XPathNodeWrapper implements MatchedNode {
  constructor(private readonly node: DomNode) {}

  text(): string {
    return this.node.textContent ?? this.node.value ?? ''
  }

  html(): string {
    return this.node.innerHTML ?? ''
  }

  outerHtml(): string {
    return this.node.outerHTML ?? ''
  }

  attr(name: string): string | undefined {
    if (typeof this.node.getAttribute === 'function') {
      const value = this.node.getAttribute(name)
      if (value !== null && value !== undefined) return value
    }
    // 属性节点：值直接挂在节点上，与属性名无关
    return this.node.value ?? this.node.textContent ?? undefined
  }

  findAll(expr: string, type: SelectorType = 'xpath'): MatchedNode[] {
    if (type === 'xpath') {
      return xpathSelect(this.node, expr).map((node) => new XPathNodeWrapper(node))
    }
    return new CheerioDocument(this.outerHtml()).selectAll(expr, 'css')
  }
}

/** 基于 cheerio 的文档实现。 */
export class CheerioDocument implements HtmlDocument {
  readonly source: string
  private readonly api: CheerioAPI
  private xpathDocument: DomNode | null = null

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

  selectAll(expr: string, type: SelectorType = 'css'): MatchedNode[] {
    if (isXPath(type)) {
      const document = this.getXPathDocument()
      return xpathSelect(document, expr).map((node) => new XPathNodeWrapper(node))
    }
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

  selectFirst(expr: string, type: SelectorType = 'css'): MatchedNode | null {
    return this.selectAll(expr, type)[0] ?? null
  }

  count(expr: string, type: SelectorType = 'css'): number {
    return this.selectAll(expr, type).length
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
    if (removed > 0) this.xpathDocument = null
    return removed
  }

  serialize(): string {
    return this.api.html()
  }

  /**
   * 懒加载 linkedom 文档；cheerio 侧发生删除后失效重建。
   *
   * 注意：必须去掉 DOCTYPE。`xpath` 库在遇到 DocumentType 节点后会让整个文档的
   * `//*` 查询返回空集（已用 linkedom 0.18 + xpath 0.0.36 实测），
   * 因此这里先剥离 DOCTYPE 与 XML 声明，再交给 linkedom。
   */
  private getXPathDocument(): DomNode {
    if (!this.xpathDocument) {
      const sanitized = this.serialize()
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<\?xml[^>]*\?>/gi, '')
      const { document } = parseHTML(sanitized)
      this.xpathDocument = document as unknown as DomNode
    }
    return this.xpathDocument
  }
}

/** 解析 HTML，得到统一文档。 */
export function parseDocument(html: string): HtmlDocument {
  return new CheerioDocument(html ?? '')
}

/** 在文档或节点作用域内查询。 */
export function selectWithin(
  scope: HtmlDocument | MatchedNode,
  expr: string,
  type: SelectorType = 'css',
): MatchedNode[] {
  if ('findAll' in scope) return scope.findAll(expr, type)
  return scope.selectAll(expr, type)
}
