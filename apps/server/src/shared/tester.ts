/**
 * 可视化规则测试器的契约。
 *
 * 测试器只是「把规则交给真实引擎跑一次」的界面，因此这里的请求体字段
 * 直接复用第三阶段的 `ListRuleConfig` / `FieldRule` / `PaginationConfig`，
 * 不在前端单独发明另一套格式。
 *
 * 预览隔离：目标站点的 HTML 会清洗后放进 sandboxed iframe，
 * iframe 与管理后台之间只允许本文件定义的消息协议通信。
 */
import type {
  ArticleData,
  FieldRule,
  PaginationConfig,
  RequestMode,
} from './crawl.js'

/* -------------------------------------------------------------------------- */
/* 请求体                                                                      */
/* -------------------------------------------------------------------------- */

/** 测试请求的公共部分：地址、模式、代理、超时。 */
export interface TesterRequestBase {
  /** 目标地址，必须是 http(s) 绝对地址 */
  url: string
  /** 请求模式，默认 http */
  mode?: RequestMode
  /** 代理 id；缺省直连。只允许引用已启用的代理 */
  proxyId?: number
  /** 超时毫秒数，服务端上限 60_000 */
  timeoutMs?: number
  /** 附加请求头 */
  headers?: Record<string, string>
}

/** 页面快照请求。 */
export interface SnapshotRequestBody extends TesterRequestBase {
  /** 浏览器模式等待策略 */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'
}

/** 列表规则测试请求：结构即 `CrawlRuleConfig.list` + `pagination`。 */
export interface ListTestRequestBody extends TesterRequestBase {
  list: {
    /** 列表插件 id：配置后由插件解析列表页，itemSelector 可省略 */
    plugin?: string
    itemSelector?: string
    /** 字段配置写法：title / url 必填，其余自定义（与保存的规则同构） */
    fields?: Record<string, FieldRule>
    linkSelector?: string
    linkAttribute?: string
    titleSelector?: string
    coverSelector?: string
    coverAttribute?: string
    /** 列表阶段的解析器插件链：列表提取完成后按顺序重格式化（与保存的规则同构） */
    parserPlugins?: string[]
    /** 列表阶段排除选择器：提取前先删除命中的节点（与保存的规则同构） */
    excludeSelectors?: string[]
  }
  pagination?: PaginationConfig
}

/** 详情规则测试请求：字段映射即 `CrawlRuleConfig.fields`，或指定详情插件。 */
export interface DetailTestRequestBody extends TesterRequestBase {
  /** 详情插件 id：配置后由插件解析详情页，fields 可省略 */
  plugin?: string
  fields?: Record<string, FieldRule>
  /** 详情阶段排除选择器：提取前先删除命中的节点（与保存的规则同构） */
  excludeSelectors?: string[]
  clean?: { removeSelectors?: string[] }
  validate?: { minContentLength?: number }
  /** 解析器插件链：详情提取完成后按顺序重格式化（与保存的规则同构） */
  parserPlugins?: string[]
}

/* -------------------------------------------------------------------------- */
/* 响应                                                                        */
/* -------------------------------------------------------------------------- */

/** 页面快照：html 已清洗（去脚本 / 事件属性 / 危险协议），供 sandboxed iframe 预览。 */
export interface PageSnapshotDto {
  ok: boolean
  url: string
  finalUrl: string | null
  statusCode: number | null
  elapsedMs: number
  mode: RequestMode
  /** 内容来自调试数据（网址完全匹配，未发真实请求） */
  debug?: boolean
  title: string | null
  /** 清洗后的 HTML；相对地址以 base 为基准解析 */
  html: string
  /** 相对地址解析基准（最终 URL） */
  base: string | null
  message: string
}

/** 列表规则测试结果（与正式采集同一引擎 `CrawlEngine.listPage`）。 */
export interface TesterListResultDto {
  ok: boolean
  url: string
  finalUrl: string | null
  statusCode: number | null
  elapsedMs: number
  mode: RequestMode
  /** 内容来自调试数据（网址完全匹配，未发真实请求） */
  debug?: boolean
  /** itemSelector 命中的节点数 */
  itemCount: number
  /** 去重后的链接数 */
  linkCount: number
  /** 因重复被丢弃的链接数 */
  duplicateCount: number
  /** 预览链接（最多 20 条） */
  links: Array<{
    url: string
    title: string | null
    coverUrl?: string | null
    /** 列表阶段抽到的作者 / 摘要 / 文章时间，用于确认内置字段选择器是否命中 */
    author?: string | null
    summary?: string | null
    articleTime?: string | null
  }>
  message: string
}

/** 单个字段的提取诊断，直接来自管道的 `FieldExtraction`。 */
export interface TesterFieldResultDto {
  key: string
  /** 提取值：字符串、字符串数组，或 object/list 字段的结构化结果 */
  value: unknown
  matched: number
  required: boolean
  ok: boolean
  error?: string
}

/** 详情规则测试结果（与正式采集同一条 `runPipeline` 链路）。 */
export interface TesterDetailResultDto {
  ok: boolean
  url: string
  finalUrl: string | null
  statusCode: number | null
  elapsedMs: number
  mode: RequestMode
  /** 内容来自调试数据（网址完全匹配，未发真实请求） */
  debug?: boolean
  /** 每个字段的提取值与命中情况 */
  fields: TesterFieldResultDto[]
  /** 必填但缺失的字段 */
  missing: string[]
  /** 字段级错误 */
  errors: string[]
  /** 校验通过时的完整文章数据 */
  article: ArticleData | null
  message: string
}

/** 规则 JSON 校验结果。 */
export interface RuleValidationDto {
  valid: boolean
  issues: Array<{ path: string; message: string }>
}

/* -------------------------------------------------------------------------- */
/* 预览 iframe 消息协议                                                        */
/* -------------------------------------------------------------------------- */

/**
 * sandboxed iframe 中的注入脚本与管理后台之间唯一的通信方式。
 * 双方都必须校验 `source === PREVIEW_MESSAGE_SOURCE`，且父页面必须校验
 * `event.source === iframe.contentWindow`，防止第三方窗口伪造消息。
 */
export const PREVIEW_MESSAGE_SOURCE = 'webcrawler-preview'

/** iframe → 父页面：点选了某个元素。 */
export interface PreviewSelectedMessage {
  source: typeof PREVIEW_MESSAGE_SOURCE
  type: 'selected'
  selector: string
  matchCount: number
  tag: string
  id: string | null
  classes: string[]
  /** 简化 DOM 路径，如 `div.list > ul.news > li:nth-of-type(2)` */
  path: string
  /** 选中元素附近的外层 HTML（截断），供「查看附近 HTML」 */
  outerHtml: string
}

/** iframe → 父页面：应用选择器后的高亮反馈。 */
export interface PreviewHighlightMessage {
  source: typeof PREVIEW_MESSAGE_SOURCE
  type: 'highlight-result'
  selector: string
  matchCount: number
  error?: string
}

/** iframe → 父页面：注入脚本初始化完成。 */
export interface PreviewReadyMessage {
  source: typeof PREVIEW_MESSAGE_SOURCE
  type: 'ready'
}

export type PreviewOutboundMessage =
  | PreviewSelectedMessage
  | PreviewHighlightMessage
  | PreviewReadyMessage

/** 父页面 → iframe：高亮（或不高亮）某个选择器的所有匹配。 */
export interface PreviewHighlightCommand {
  source: typeof PREVIEW_MESSAGE_SOURCE
  type: 'highlight'
  selector: string | null
}

/** 父页面 → iframe：清除高亮。 */
export interface PreviewClearCommand {
  source: typeof PREVIEW_MESSAGE_SOURCE
  type: 'clear'
}

export type PreviewInboundCommand = PreviewHighlightCommand | PreviewClearCommand

/** 判断未知数据是否是合法的预览出站消息（用于父页面 onmessage 入口）。 */
export function isPreviewOutboundMessage(
  payload: unknown,
): payload is PreviewOutboundMessage {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  if (record.source !== PREVIEW_MESSAGE_SOURCE) return false
  switch (record.type) {
    case 'selected':
      return (
        typeof record.selector === 'string' &&
        typeof record.matchCount === 'number' &&
        typeof record.tag === 'string' &&
        typeof record.outerHtml === 'string'
      )
    case 'highlight-result':
      return typeof record.selector === 'string' && typeof record.matchCount === 'number'
    case 'ready':
      return true
    default:
      return false
  }
}
