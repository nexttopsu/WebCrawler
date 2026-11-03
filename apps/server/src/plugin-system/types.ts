/**
 * 插件契约。
 *
 * 插件只处理「网站差异」：匹配站点、给出列表链接、解析详情。
 * 请求、解析、清洗、校验都由 src/core 提供，插件不得直接访问数据库，
 * 也不得自行创建 HTTP 客户端。
 */
import type { ArticleData, ArticleLink, CrawlContext, PluginType } from '../shared/index.js'
// 插件作者可以从本包直接拿到枚举值，不必再引一次 shared
export { PluginType } from '../shared/index.js'
import type { CrawlServices, Parser } from '../core/index.js'

/** 插件清单：描述插件身份与入口。 */
export interface PluginManifest {
  /** 全局唯一名称，对应 `plugin.name` 唯一索引 */
  name: string
  version: string
  type: PluginType
  /** 插件入口（文件路径或模块名），仅做登记 */
  entry?: string
  description?: string
  /** 兼容的核心版本范围，例如 `^0.2.0` */
  coreVersion?: string
  /** 插件配置（JSON 可序列化） */
  config?: Record<string, unknown>
}

/** 插件生命周期与基础身份。 */
export interface CrawlerPlugin {
  readonly name: string
  readonly version: string
  readonly type: PluginType
  /** 注入能力（请求、解析）；插件在此保存引用，不要创建新的客户端 */
  initialize(services: CrawlServices): void | Promise<void>
  /** 释放资源 */
  destroy(): void | Promise<void>
}

/** 站点插件：在通用能力之上增加站点匹配与列表 / 详情策略。 */
export interface SitePlugin extends CrawlerPlugin {
  /** 判断该插件是否负责这个地址 */
  match(url: string): boolean
  /** 提取列表页中的文章链接 */
  getList(context: CrawlContext): Promise<ArticleLink[]>
  /** 解析详情页；`link` 省略时使用 `context.url` */
  parseDetail(context: CrawlContext, link?: ArticleLink): Promise<ArticleData>
}

/** 解析器插件的输入：html2object 提取完成的原始数据。 */
export interface ParserTransformInput {
  /** 提取结果（固定字段 + 自定义字段），插件可直接修改字段值 */
  data: Record<string, unknown>
  /** 当前页面的原始 HTML（清洗前），需要整页上下文时使用 */
  html: string
  /** 当前页面地址（绝对地址） */
  url: string
  /** 执行阶段：list = 列表字段提取后，detail = 详情字段提取后 */
  stage: 'list' | 'detail'
}

/**
 * 解析器插件：对提取完成的数据做重格式化（如图片地址解密）。
 *
 * 挂载点在字段提取之后、清洗入库之前；规则里通过 `parserPlugins`
 * 按数组顺序链式调用，前一个插件的输出是后一个插件的输入。
 */
export interface ParserPlugin extends CrawlerPlugin {
  /** 重格式化数据；返回处理后的字段对象 */
  transform(input: ParserTransformInput): Promise<Record<string, unknown>> | Record<string, unknown>
}

/** 插件运行错误分类。 */
export const PluginErrorCode = {
  /** 插件未初始化就调用了能力 */
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  /** 插件不支持该站点 */
  NOT_MATCHED: 'NOT_MATCHED',
  /** 插件执行失败（规则缺失、选择器非法等） */
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  /** 抓取到的数据未通过校验 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
} as const
export type PluginErrorCode = (typeof PluginErrorCode)[keyof typeof PluginErrorCode]

/** 插件错误：统一包装核心层异常，避免插件把底层错误直接抛给引擎。 */
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

/** 插件能力检测：判断对象是否实现了站点插件契约。 */
export function isSitePlugin(plugin: CrawlerPlugin): plugin is SitePlugin {
  const candidate = plugin as Partial<SitePlugin>
  return (
    typeof candidate.match === 'function' &&
    typeof candidate.getList === 'function' &&
    typeof candidate.parseDetail === 'function'
  )
}

/** 插件能力检测：判断对象是否实现了解析器插件契约。 */
export function isParserPlugin(plugin: CrawlerPlugin): plugin is ParserPlugin {
  return typeof (plugin as Partial<ParserPlugin>).transform === 'function'
}

/** 插件可用的解析器类型，便于插件作者标注。 */
export type PluginParser = Parser
