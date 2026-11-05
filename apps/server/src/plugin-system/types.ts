/**
 * 插件契约（内置版）。
 *
 * 插件是服务端源码的一部分：写在 `src/plugins/*.ts`，由 `src/plugins/index.ts` 汇总，
 * 进程启动时一次性注册，运行期间不扫描目录、不重新加载文件。
 *
 * ```ts
 * import { definePlugin } from '../plugin-system/sdk.js'
 *
 * export default definePlugin({
 *   config: { id: 'example', name: '示例站', type: 'flow' },
 *   // 全流程：抓取 + 解析，两个函数可以只写一个
 *   async getList(url, ctx) { return [{ url, title: '标题' }] },
 *   async getDetail(url, ctx) { return { title: '标题', content: '<p>正文</p>' } },
 * })
 * ```
 *
 * 写插件请用 `definePlugin` 而不是直接手写对象：它会把返回结构、函数与 type 的匹配
 * 一起交给编译器检查。类型定义在本文件，`sdk.ts` 只做约束与收窄。
 *
 * 插件不直接访问数据库，也不自己创建 HTTP 客户端——需要联网时用 `ctx.request`，
 * 这样代理、限速、SSRF 校验与超时重试仍然由平台统一负责。
 */
import type { Parser } from '../core/index.js'
import type {
  CategorySnapshot,
  CrawlRequestOptions,
  RuleSnapshot,
  SiteSnapshot,
} from '../shared/index.js'
import type { ProxySettings, RequestMode } from '../shared/index.js'
import type { ScopedRequestClient } from '../request/index.js'
import type {
  AttrField,
  Field,
  HtmlField,
  JsonField,
  LoopField,
  ObjectField,
  ParsedResult,
  QueryOptions,
  Schema as Html2ObjectSchema,
  TextField,
} from 'request-pack'

/** 插件类型：全流程 / 解析器。 */
export type PluginType = 'flow' | 'parser'

/**
 * 插件能作用的阶段。
 *
 * 能力由插件**实际导出的函数**决定，不在配置里手写：
 * - 全流程：`getList` → 列表，`getDetail` → 详情；
 * - 解析器：`parseList` → 列表条目，`parseDetail` → 整篇详情。
 */
export type PluginSlot = 'list' | 'detail'

/** 插件导出的配置。 */
export interface PluginConfig {
  /** 稳定标识：规则里引用它，改文件名或显示名都不影响关联 */
  id: string
  /** 显示名称 */
  name: string
  type: PluginType
  /** 插件自己的版本号，仅用于展示 */
  version?: string
  description?: string
}

/** 插件抓取到的一页：只保留插件真正需要的三样东西。 */
export interface PluginFetchedPage {
  /** 渲染 / 下载后的 HTML（browser 模式是执行过 JS 的 DOM） */
  html: string
  /** 重定向后的最终地址，解析相对链接时以它为准 */
  finalUrl: string
  /** HTTP 状态码；browser 模式取主文档响应 */
  status: number
}

/**
 * `request-pack` 的 `html2object`：按 schema 把整页 HTML 一次解析成结构化对象，
 * 结果类型自动推导。与 `ctx.schema` 搭配使用，插件里不需要再 import request-pack。
 *
 * ```ts
 * const data = ctx.html2object(page.html, {
 *   title: ctx.schema.text('h1'),
 *   author: ctx.schema.nullable(ctx.schema.text('.author')),
 *   tags: ctx.schema.loop('.tag', ctx.schema.text('')),
 * })
 * ```
 */
export type Html2ObjectFn = <S extends Html2ObjectSchema>(
  html: string,
  schema: S,
  removeSelector?: string[],
) => ParsedResult<S>

/**
 * `html2object` 的 schema 字段构造器集合（request-pack 同名函数的原样注入）。
 *
 * 页面解析配置全部在这里拼：单值 `text / html / attr / json`，
 * 列表 `loop`，嵌套 `object`，兜底 `nullable`。
 */
export interface PluginSchemaBuilders {
  /** 提取元素文本 */
  text(selector: string, options?: QueryOptions): TextField
  /** 提取 innerHTML */
  html(selector: string, options?: QueryOptions): HtmlField
  /** 提取属性 */
  attr(name: string, selector?: string, options?: QueryOptions): AttrField
  /** 把元素文本当 JSON 解析（如 `<script type="application/ld+json">`） */
  json(selector: string): JsonField
  /** 遍历列表：schema 传对象得到对象数组，传单个字段得到标量数组 */
  loop<S extends Html2ObjectSchema | Field>(selector: string, schema: S): LoopField<S>
  /** 在某个子树内解析，产出嵌套对象 */
  object<S extends Html2ObjectSchema>(schema: S): ObjectField<S>
  object<S extends Html2ObjectSchema>(selector: string, schema: S): ObjectField<S>
  /** 让字段在未匹配时返回 null（而不是空字符串） */
  nullable<F extends Field>(field: F): F & { nullable: true }
}

/** 插件运行上下文：平台能力注入。 */
export interface PluginContext {
  /**
   * 平台请求器（已绑定本次运行的代理）。
   *
   * 是纯 HTTP：不执行 JS，也不渲染页面。需要 JS 渲染时用 `ctx.fetchPage`。
   * 默认代理由平台填入；传 `{ proxy: null }` 可让单次请求直连，
   * 传 `{ proxy }` 可覆盖本次代理。
   */
  request: ScopedRequestClient
  /**
   * 按本次运行的模式抓取页面：`mode === 'browser'` 时走浏览器渲染，
   * 否则走 HTTP。与引擎内部的抓取是同一条路径（代理 / SSRF / 超时一致）。
   *
   * 列表插件默认用不上它——平台已经把分页后的地址交给了 `getList`；
   * 需要进详情页或调接口时再调。
   */
  fetchPage: (url: string) => Promise<PluginFetchedPage>
  /** 本次运行使用的代理；`null` 表示直连。只读信息，发请求用 `ctx.request` 即可 */
  proxy: ProxySettings | null
  /** 本次运行的模式（测试器 / 栏目规则里选的那个） */
  mode: RequestMode
  /** 解析器：parseHtml / cleanText / normalizeUrl 等，避免插件自己引依赖 */
  parser: Parser
  /** request-pack 的 `html2object`：按 schema 一次解析整页 HTML（用法见类型注释） */
  html2object: Html2ObjectFn
  /** `html2object` 的 schema 字段构造器：text / html / attr / json / loop / object / nullable */
  schema: PluginSchemaBuilders
  /**
   * 本次运行的页面配置（只读快照，改了不影响采集流程）：
   * `site` 站点、`category` 栏目（含 listUrl）、`rule` 生效规则
   * （站点默认 < 栏目 < 任务覆盖 合并结果，插件可以读 `rule.config` 里的字段配置）、
   * `requestOptions` 请求级配置（超时 / 请求头 / 编码等）。
   */
  site: SiteSnapshot
  category: CategorySnapshot
  rule: RuleSnapshot
  requestOptions: CrawlRequestOptions
  /** 结构化日志；不要用 console，日志要能进任务日志 */
  logger: {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string) => void
  }
  /** 当前站点 / 栏目 id（便捷访问，同 `ctx.site.id` / `ctx.category.id`） */
  siteId?: string
  categoryId?: string
}

/** 字段对象：键是字段名（title / author / content…），值是插件处理后要保存的内容。 */
export type ArticleFields = Record<string, unknown>

/** 全流程 · 列表函数：入参是分页后的完整地址，返回该页的条目数组。 */
export type FlowListFn = (url: string, ctx: PluginContext) => Promise<FlowListItem[]>

/** 全流程 · 详情函数：入参是文章地址，返回一篇文章的字段对象。 */
export type FlowDetailFn = (url: string, ctx: PluginContext) => Promise<FlowDetailResult>

/** 解析器函数：入参是 url + 当前字段对象，返回处理后的字段对象。 */
export type ParserFn = (url: string, fields: ArticleFields, ctx: PluginContext) => Promise<ArticleFields>

/** @deprecated 使用 ParserFn；保留别名避免调用方改动。 */
export type PluginRun = ParserFn

/** 插件模块的运行时形态：至少实现与 type 匹配的一个函数。 */
export interface PluginModule {
  config: PluginConfig
  /** 全流程 · 列表：抓取并解析列表页 */
  getList?: FlowListFn
  /** 全流程 · 详情：抓取并解析详情页 */
  getDetail?: FlowDetailFn
  /** 解析器 · 列表：处理单个列表条目的字段 */
  parseList?: ParserFn
  /** 解析器 · 详情：处理整篇文章的字段 */
  parseDetail?: ParserFn
}

/** 注册表里的插件：模块 + 来源标识。 */
export interface RegisteredPlugin extends PluginModule {
  /** 来源：内置插件填源码相对路径（如 `src/plugins/demo-fixture.ts`），用于错误提示与界面展示 */
  source: string
}

/** 插件支持的阶段（由导出的函数推导）。 */
export function pluginSlots(plugin: PluginModule): PluginSlot[] {
  const slots: PluginSlot[] = []
  if (plugin.config.type === 'flow') {
    if (typeof plugin.getList === 'function') slots.push('list')
    if (typeof plugin.getDetail === 'function') slots.push('detail')
    return slots
  }
  if (typeof plugin.parseList === 'function') slots.push('list')
  if (typeof plugin.parseDetail === 'function') slots.push('detail')
  return slots
}

/** 插件的中文类型文案：列表插件 / 详情插件 / 列表 + 详情插件 / 解析器（列表 + 详情）。 */
export function describePlugin(plugin: PluginModule): string {
  const slots = pluginSlots(plugin)
  const scope =
    slots.length === 2 ? '列表 + 详情' : slots[0] === 'list' ? '列表' : slots[0] === 'detail' ? '详情' : '未实现函数'
  return plugin.config.type === 'parser' ? `解析器（${scope}）` : `${scope}插件`
}

/** 全流程插件在列表阶段返回的单条数据。 */
export interface FlowListItem {
  /** 文章绝对地址（必填，非 http(s) 会被丢弃） */
  url: string
  title?: string
  coverUrl?: string
  author?: string
  summary?: string
  content?: string
  /** 原站点发布时间（原始字符串，入库前统一转 ISO 8601） */
  articleTime?: string
  /** 自定义字段，入库存 extra */
  extra?: Record<string, unknown>
}

/** 全流程插件在详情阶段返回的一篇文章。 */
export interface FlowDetailResult {
  /**
   * 文章标题（必填）。
   *
   * 引擎把「没有标题」视为这一篇解析失败——宁可记一条错误，
   * 也不要往库里塞一篇没有标题的脏数据。
   */
  title: string
  /** 页面里抽到的规范地址；省略时用列表链接的地址 */
  url?: string
  author?: string
  summary?: string
  content?: string
  coverUrl?: string
  articleTime?: string
  extra?: Record<string, unknown>
}

/** 插件运行错误分类。 */
export const PluginErrorCode = {
  /** 插件未初始化就调用了能力（旧契约遗留，保留以免调用方编译失败） */
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  /** 插件不支持该站点 */
  NOT_MATCHED: 'NOT_MATCHED',
  /** 插件执行失败 */
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  /** 插件返回的数据未通过校验 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
} as const
export type PluginErrorCode = (typeof PluginErrorCode)[keyof typeof PluginErrorCode]

/** 插件错误：带插件名与错误码，便于日志定位。 */
export class PluginError extends Error {
  override readonly name = 'PluginError'

  constructor(
    readonly pluginName: string,
    readonly code: PluginErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** 注册失败的原因。 */
export class PluginRegistryError extends Error {
  override readonly name = 'PluginRegistryError'
}

/** 插件可用的解析器类型，便于插件作者标注。 */
export type PluginParser = Parser
