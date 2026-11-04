/**
 * 领域枚举。
 *
 * SQLite 没有原生枚举，数据库中以 TEXT 存储，这里给出唯一的取值来源，
 * 服务端与前端都从这里导入，避免散落的字符串字面量。
 */

/** 站点状态。 */
export const SiteStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const
export type SiteStatus = (typeof SiteStatus)[keyof typeof SiteStatus]

/** 栏目状态。 */
export const CategoryStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const
export type CategoryStatus = (typeof CategoryStatus)[keyof typeof CategoryStatus]

/** 采集规则状态。 */
export const CrawlRuleStatus = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
} as const
export type CrawlRuleStatus = (typeof CrawlRuleStatus)[keyof typeof CrawlRuleStatus]

/**
 * 采集任务状态。
 *
 * 取值与第五阶段任务书的六态一致；`completed` / `failed` / `cancelled`
 * 是终态，只能通过「重试」重新进入 `pending`。
 */
export const CrawlTaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const
export type CrawlTaskStatus = (typeof CrawlTaskStatus)[keyof typeof CrawlTaskStatus]

/**
 * 采集任务类型。
 *
 * - `site`：站点下全部启用栏目
 * - `category`：单个栏目
 * - `batch`：多个指定栏目
 * - `urls`：指定 URL 列表（仍走同一套规则与详情管道）
 * - `full`：全量（忽略增量跳过规则）
 * - `incremental`：增量（跳过已采集 URL 与早于时间窗口的内容）
 * - `list`：仅列表采集——只抓列表页，命中即入库（title + url 必填），
 *   文章 `detailStatus` 记为 `pending`，详情留待补采
 * - `detail`：仅详情补采——只处理 `detailStatus ≠ collected` 的文章，
 *   逐篇抓详情页，同名字段有值才覆盖列表阶段的值
 */
export const CrawlTaskType = {
  SITE: 'site',
  CATEGORY: 'category',
  BATCH: 'batch',
  URLS: 'urls',
  FULL: 'full',
  INCREMENTAL: 'incremental',
  LIST: 'list',
  DETAIL: 'detail',
} as const
export type CrawlTaskType = (typeof CrawlTaskType)[keyof typeof CrawlTaskType]

/**
 * 文章详情采集状态。
 *
 * `detailStatus` 只回答「这篇文章的详情页抓过了没有」。
 */
export const ArticleDetailStatus = {
  /** 已入库（列表阶段），详情未采集 */
  PENDING: 'pending',
  /** 详情已采集完成 */
  COLLECTED: 'collected',
  /** 详情采集失败，可重试 */
  FAILED: 'failed',
} as const
export type ArticleDetailStatus = (typeof ArticleDetailStatus)[keyof typeof ArticleDetailStatus]

/** 任务触发方式：手动创建 / 定时调度 / 失败重试。 */
export const CrawlTaskTrigger = {
  MANUAL: 'manual',
  SCHEDULE: 'schedule',
  RETRY: 'retry',
} as const
export type CrawlTaskTrigger = (typeof CrawlTaskTrigger)[keyof typeof CrawlTaskTrigger]

/** 日志级别，与 logger 的等级一致。 */
export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

/** 代理状态。 */
export const ProxyStatus = {
  UNKNOWN: 'unknown',
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  DISABLED: 'disabled',
} as const
export type ProxyStatus = (typeof ProxyStatus)[keyof typeof ProxyStatus]

/** 代理协议。 */
export const ProxyProtocol = {
  HTTP: 'http',
  HTTPS: 'https',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
} as const
export type ProxyProtocol = (typeof ProxyProtocol)[keyof typeof ProxyProtocol]

/** 插件类型。 */
export const PluginType = {
  /** 数据源（列表页/详情页的抓取策略） */
  SOURCE: 'source',
  /** 解析器（从 HTML 中提取结构化数据） */
  PARSER: 'parser',
  /** 导出器（把文章写入外部系统） */
  EXPORTER: 'exporter',
  /** 生命周期钩子 */
  HOOK: 'hook',
} as const
export type PluginType = (typeof PluginType)[keyof typeof PluginType]

/** 采集阶段。日志与错误共用，取值面向排查问题而不是内部模块名。 */
export const CrawlErrorStage = {
  /** 任务生命周期（创建 / 暂停 / 恢复 / 取消 / 完成） */
  TASK: 'task',
  /** 列表页抓取与链接提取 */
  LIST: 'list',
  /** 详情页抓取 */
  REQUEST: 'request',
  /** HTML 解析 */
  PARSE: 'parse',
  /** 字段提取 */
  EXTRACT: 'extract',
  /** 数据校验 */
  VALIDATE: 'validate',
  /** 落库 */
  SAVE: 'save',
  /** 定时调度 */
  SCHEDULE: 'schedule',
} as const
export type CrawlErrorStage = (typeof CrawlErrorStage)[keyof typeof CrawlErrorStage]
