/**
 * 插件编写入口：给内置插件用的类型约束。
 *
 * 插件只写一个对象传给 `definePlugin`，剩下的由编译器检查：
 *
 * - `config.type === 'flow'` 时只能写 `getList` / `getDetail`，写 `parseList` 会报错；
 * - `config.type === 'parser'` 时只能写 `parseList` / `parseDetail`；
 * - 两个函数一个都不写会报错（插件得有能干活的地方）；
 * - 返回值结构必须对得上：`getList` 是 `FlowListItem[]`，`getDetail` 是 `FlowDetailResult`，
 *   解析器是 `ArticleFields`。少写 `url`、把详情写成数组，都会在编译期被拦下来。
 *
 * 编辑器里的补全来自 `PluginContext`：`ctx.request` 有 `get / post / getText / getJson`
 * （纯 HTTP，已绑定本次代理），`ctx.fetchPage` 按当前模式抓页面（browser 模式会执行 JS），
 * `ctx.parser` 有 `parseHtml / selectAll / cleanText / resolveUrl`，不用猜。
 */
import type {
  ArticleFields,
  FlowDetailFn,
  FlowDetailResult,
  FlowListItem,
  FlowListFn,
  ParserFn,
  PluginConfig,
  PluginContext,
  PluginFetchedPage,
  PluginModule,
} from './types.js'

export type {
  ArticleFields,
  FlowDetailFn,
  FlowDetailResult,
  FlowListItem,
  FlowListFn,
  ParserFn,
  PluginConfig,
  PluginContext,
  PluginFetchedPage,
  PluginModule,
}

/** 全流程插件的配置：`type` 收窄成字面量，避免写成变量后失去约束。 */
export interface FlowPluginConfig extends Omit<PluginConfig, 'type'> {
  type: 'flow'
}

/** 解析器插件的配置。 */
export interface ParserPluginConfig extends Omit<PluginConfig, 'type'> {
  type: 'parser'
}

/** 只做列表的全流程插件。 */
export interface FlowListOnlyModule {
  config: FlowPluginConfig
  getList: FlowListFn
  getDetail?: FlowDetailFn
}

/** 只做详情的全流程插件。 */
export interface FlowDetailOnlyModule {
  config: FlowPluginConfig
  getList?: FlowListFn
  getDetail: FlowDetailFn
}

/** 全流程插件：列表 / 详情至少实现一个。 */
export type FlowPluginModule = FlowListOnlyModule | FlowDetailOnlyModule

/** 只处理列表条目的解析器插件。 */
export interface ParserListOnlyModule {
  config: ParserPluginConfig
  parseList: ParserFn
  parseDetail?: ParserFn
}

/** 只处理整篇详情的解析器插件。 */
export interface ParserDetailOnlyModule {
  config: ParserPluginConfig
  parseList?: ParserFn
  parseDetail: ParserFn
}

/** 解析器插件：列表 / 详情至少实现一个。 */
export type ParserPluginModule = ParserListOnlyModule | ParserDetailOnlyModule

/**
 * 定义一个插件。
 *
 * 返回值统一成 `PluginModule`，注册表只关心这个形状；
 * 真正的价值在入参：类型与函数不匹配、返回值结构不对，都在写代码时就报错。
 */
export function definePlugin(plugin: FlowPluginModule): PluginModule
export function definePlugin(plugin: ParserPluginModule): PluginModule
export function definePlugin(plugin: FlowPluginModule | ParserPluginModule): PluginModule {
  return plugin as PluginModule
}

/**
 * 运行时兜底校验：编译期已经拦过一遍，这里只挡住「绕过 definePlugin 手写对象」的情况。
 *
 * 返回错误文案，通过时返回 `null`。
 */
export function validatePluginModule(plugin: PluginModule): string | null {
  const config = plugin.config
  if (!config || typeof config !== 'object') return '缺少 config'
  if (!config.id?.trim()) return 'config.id 不能为空'
  if (!config.name?.trim()) return 'config.name 不能为空'

  const getList = typeof plugin.getList === 'function'
  const getDetail = typeof plugin.getDetail === 'function'
  const parseList = typeof plugin.parseList === 'function'
  const parseDetail = typeof plugin.parseDetail === 'function'

  if (config.type === 'flow') {
    if (!getList && !getDetail) return '全流程插件至少要实现 getList 或 getDetail'
    if (parseList || parseDetail) return '全流程插件用 getList / getDetail；字段后处理请用 type: "parser"'
    return null
  }
  if (config.type === 'parser') {
    if (!parseList && !parseDetail) return '解析器插件至少要实现 parseList 或 parseDetail'
    if (getList || getDetail) return '解析器插件用 parseList / parseDetail；整页抓取请用 type: "flow"'
    return null
  }
  return `未知的插件类型：${String(config.type)}`
}

/**
 * 插件可用的平台能力，方便在辅助函数里标注参数。
 *
 * 例如把解析逻辑拆成独立函数时，可以这样写：
 * `function parseItem(node: MatchedNode, ctx: PluginContext)`。
 */
export type PluginRuntime = PluginContext

export type { MatchedNode, HtmlDocument } from '../core/parser/document.js'
