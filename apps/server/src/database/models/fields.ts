import type { ModelFields, ModelRow } from 'ormlet'

/**
 * 模型字段定义。
 *
 * ORMlet 的字段类型只有 TEXT / INTEGER / REAL / BLOB 四种，
 * 且每张表自动带有 `id`（自增主键）与 `createdAt` / `updatedAt`（ISO 8601 字符串）。
 * 因此这里不重复声明主键与时间戳，时间字段统一用 TEXT 存 ISO 8601。
 *
 * 所有可空性由 ORMlet 的类型推导（`ModelRow` 中字段类型为 `T | null`），
 * 业务层的默认值在写入时补全。
 */

/**
 * 网站。
 *
 * `domain` 只存主机名（如 `example.com`），`baseUrl` 存完整基址；
 * `defaultProxyId` 与 `defaultRuleId` 都是软引用，由服务层校验有效性
 * （ORMlet 不支持外键，删除策略在业务层实现）。
 */
export const siteFields = {
  name: 'TEXT',
  domain: 'TEXT',
  baseUrl: 'TEXT',
  pluginName: 'TEXT',
  defaultProxyId: 'INTEGER',
  defaultRuleId: 'INTEGER',
  status: 'TEXT',
  description: 'TEXT',
} as const satisfies ModelFields
export type SiteFields = typeof siteFields
export type SiteRow = ModelRow<SiteFields>
export const SITE_TABLE = 'site'

/** 栏目。`enabled` 用 INTEGER 存 0/1，对外映射为布尔值。 */
export const categoryFields = {
  siteId: 'INTEGER',
  name: 'TEXT',
  code: 'TEXT',
  listUrl: 'TEXT',
  ruleId: 'INTEGER',
  proxyId: 'INTEGER',
  enabled: 'INTEGER',
  /** 自动采集间隔（秒）；0 表示不自动采集 */
  crawlInterval: 'INTEGER',
  sortOrder: 'INTEGER',
  description: 'TEXT',
} as const satisfies ModelFields
export type CategoryFields = typeof categoryFields
export type CategoryRow = ModelRow<CategoryFields>
export const CATEGORY_TABLE = 'category'

/**
 * 采集规则。
 *
 * `config` 存规则 JSON（经过 Schema 校验），`version` 是修订号。
 * `categoryId` 为空表示站点级规则，可作为栏目的继承来源。
 */
export const crawlRuleFields = {
  siteId: 'INTEGER',
  categoryId: 'INTEGER',
  name: 'TEXT',
  config: 'TEXT',
  version: 'INTEGER',
  status: 'TEXT',
  description: 'TEXT',
} as const satisfies ModelFields
export type CrawlRuleFields = typeof crawlRuleFields
export type CrawlRuleRow = ModelRow<CrawlRuleFields>
export const CRAWL_RULE_TABLE = 'crawl_rule'

/** 规则版本快照：每次配置变更追加一行，历史版本不可覆盖。 */
export const crawlRuleVersionFields = {
  ruleId: 'INTEGER',
  version: 'INTEGER',
  config: 'TEXT',
  note: 'TEXT',
} as const satisfies ModelFields
export type CrawlRuleVersionFields = typeof crawlRuleVersionFields
export type CrawlRuleVersionRow = ModelRow<CrawlRuleVersionFields>
export const CRAWL_RULE_VERSION_TABLE = 'crawl_rule_version'

/**
 * 采集任务。
 *
 * `configSnapshot` 是任务创建时固化的执行依据（站点、栏目、合并后的规则），
 * `checkpoint` 记录断点（已处理 URL、当前页），用于暂停恢复与重启判定。
 * `categoryId` / `ruleVersion` / `ruleSnapshot` 是第三阶段的单栏目字段，
 * 保留下来兼容旧数据；新任务以 `categoryIds` 与 `configSnapshot` 为准。
 */
export const crawlTaskFields = {
  name: 'TEXT',
  siteId: 'INTEGER',
  categoryId: 'INTEGER',
  /** 栏目 id 数组（JSON） */
  categoryIds: 'TEXT',
  ruleId: 'INTEGER',
  /** site / category / batch / urls / full / incremental */
  type: 'TEXT',
  /** pending / running / paused / completed / failed / cancelled */
  status: 'TEXT',
  /** manual / schedule / retry */
  trigger: 'TEXT',
  scheduleId: 'INTEGER',
  /** 任务配置快照（JSON） */
  configSnapshot: 'TEXT',
  ruleVersion: 'INTEGER',
  ruleSnapshot: 'TEXT',
  totalCount: 'INTEGER',
  successCount: 'INTEGER',
  failedCount: 'INTEGER',
  skippedCount: 'INTEGER',
  currentPage: 'INTEGER',
  totalPages: 'INTEGER',
  attempts: 'INTEGER',
  /** 断点（JSON） */
  checkpoint: 'TEXT',
  errorSummary: 'TEXT',
  startedAt: 'TEXT',
  completedAt: 'TEXT',
  /** 以下为第一阶段遗留列，保留声明以免旧库与新库结构漂移 */
  cron: 'TEXT',
  lastRunAt: 'TEXT',
  nextRunAt: 'TEXT',
  failCount: 'INTEGER',
  message: 'TEXT',
} as const satisfies ModelFields
export type CrawlTaskFields = typeof crawlTaskFields
export type CrawlTaskRow = ModelRow<CrawlTaskFields>
export const CRAWL_TASK_TABLE = 'crawl_task'

/** 文章。正文保留纯文本与原始 HTML（有大小上限）。 */
export const articleFields = {
  siteId: 'INTEGER',
  categoryId: 'INTEGER',
  taskId: 'INTEGER',
  title: 'TEXT',
  url: 'TEXT',
  author: 'TEXT',
  summary: 'TEXT',
  /** 纯文本正文 */
  content: 'TEXT',
  /** 抓取到的原始 HTML，供「原始数据」查看 */
  rawHtml: 'TEXT',
  coverUrl: 'TEXT',
  /** 规则中未映射到标准字段的其余字段（JSON） */
  extra: 'TEXT',
  /** 详情采集状态：pending（仅列表入库）/ collected（详情已采集）/ failed（详情失败） */
  detailStatus: 'TEXT',
  /** 文章时间：采集数据时标注的原站点发布时间（ISO 8601） */
  articleTime: 'TEXT',
} as const satisfies ModelFields
export type ArticleFields = typeof articleFields
export type ArticleRow = ModelRow<ArticleFields>
export const ARTICLE_TABLE = 'article'

/** 代理。密码以 AES-256-GCM 密文存储，绝不返回接口。 */
export const proxyFields = {
  name: 'TEXT',
  host: 'TEXT',
  port: 'INTEGER',
  protocol: 'TEXT',
  username: 'TEXT',
  password: 'TEXT',
  /** 是否启用；禁用后不再被任务选中 */
  enabled: 'INTEGER',
  /** unknown / available / unavailable / disabled */
  status: 'TEXT',
  failCount: 'INTEGER',
  successCount: 'INTEGER',
  requestCount: 'INTEGER',
  lastCheckedAt: 'TEXT',
  /** 最近一次连通性测试的结论（available / unavailable） */
  lastTestStatus: 'TEXT',
  lastUsedAt: 'TEXT',
  expiresAt: 'TEXT',
} as const satisfies ModelFields
export type ProxyFields = typeof proxyFields
export type ProxyRow = ModelRow<ProxyFields>
export const PROXY_TABLE = 'proxy'

/** 插件。 */
export const pluginFields = {
  name: 'TEXT',
  version: 'TEXT',
  type: 'TEXT',
  entry: 'TEXT',
  enabled: 'INTEGER',
  description: 'TEXT',
  config: 'TEXT',
} as const satisfies ModelFields
export type PluginFields = typeof pluginFields
export type PluginRow = ModelRow<PluginFields>
export const PLUGIN_TABLE = 'plugin'

/** 采集错误。 */
export const crawlErrorFields = {
  taskId: 'INTEGER',
  siteId: 'INTEGER',
  categoryId: 'INTEGER',
  url: 'TEXT',
  stage: 'TEXT',
  message: 'TEXT',
  detail: 'TEXT',
  occurredAt: 'TEXT',
} as const satisfies ModelFields
export type CrawlErrorFields = typeof crawlErrorFields
export type CrawlErrorRow = ModelRow<CrawlErrorFields>
export const CRAWL_ERROR_TABLE = 'crawl_error'

/**
 * 任务日志。
 *
 * 与 `crawl_error` 分开：`crawl_error` 记录「哪篇文章失败了」，
 * `crawl_log` 记录任务全生命周期的结构化日志（含 info / warn），
 * `/api/logs` 只读这一张表，避免两种语义混在一起。
 */
export const crawlLogFields = {
  taskId: 'INTEGER',
  siteId: 'INTEGER',
  categoryId: 'INTEGER',
  /** 已脱敏的 URL（敏感查询参数被替换为 ***） */
  url: 'TEXT',
  level: 'TEXT',
  stage: 'TEXT',
  message: 'TEXT',
  detail: 'TEXT',
} as const satisfies ModelFields
export type CrawlLogFields = typeof crawlLogFields
export type CrawlLogRow = ModelRow<CrawlLogFields>
export const CRAWL_LOG_TABLE = 'crawl_log'

/**
 * 定时采集配置。
 *
 * `cron` 存 5 段表达式（由频率 + 时间字段生成或用户直接给出），
 * `timezone` 为 IANA 名称。调度器到期后只创建 CrawlTask，不直接执行采集。
 */
export const crawlScheduleFields = {
  name: 'TEXT',
  siteId: 'INTEGER',
  /** 栏目 id 数组（JSON）；空数组表示站点下全部启用栏目 */
  categoryIds: 'TEXT',
  taskType: 'TEXT',
  frequency: 'TEXT',
  cron: 'TEXT',
  timezone: 'TEXT',
  enabled: 'INTEGER',
  /** 任务参数（JSON，复用 TaskOptions） */
  options: 'TEXT',
  lastRunAt: 'TEXT',
  nextRunAt: 'TEXT',
  lastTaskId: 'INTEGER',
  description: 'TEXT',
} as const satisfies ModelFields
export type CrawlScheduleFields = typeof crawlScheduleFields
export type CrawlScheduleRow = ModelRow<CrawlScheduleFields>
export const CRAWL_SCHEDULE_TABLE = 'crawl_schedule'

/** 系统设置。 */
export const systemSettingFields = {
  settingKey: 'TEXT',
  settingValue: 'TEXT',
  description: 'TEXT',
  groupName: 'TEXT',
} as const satisfies ModelFields
export type SystemSettingFields = typeof systemSettingFields
export type SystemSettingRow = ModelRow<SystemSettingFields>
export const SYSTEM_SETTING_TABLE = 'system_setting'
