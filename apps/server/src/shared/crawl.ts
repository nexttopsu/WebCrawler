import type { ProxyProtocol } from './domain.js'

/**
 * 采集核心的公共类型。
 *
 * 这里只放「跨包共享的数据契约」：采集结果、上下文、规则结构。
 * 具体实现（请求、解析、执行）分别位于 src/request 与 src/core，
 * 保证共享包不依赖任何运行时实现，也不产生循环依赖。
 */

/* -------------------------------------------------------------------------- */
/* 采集结果                                                                    */
/* -------------------------------------------------------------------------- */

/** 列表页解析出的一条文章线索。 */
export interface ArticleLink {
  /** 列表页上展示的标题，可能为空 */
  title?: string
  /** 列表项上提取的封面图，已转为绝对地址；未配置 coverSelector 时为空 */
  coverUrl?: string
  /** 列表阶段提取的作者；为空时留待详情阶段补采 */
  author?: string
  /** 列表阶段提取的摘要 */
  summary?: string
  /** 列表阶段提取的正文 */
  content?: string
  /** 列表阶段提取的文章时间（原始字符串，入库前统一转 ISO 8601） */
  articleTime?: string
  /** 文章 URL，已转为绝对地址 */
  url: string
  /** 发现该链接的列表页 URL */
  sourceUrl: string
  metadata?: Record<string, unknown>
}

/** 详情页解析出的统一文章数据。 */
export interface ArticleData {
  siteId: string
  categoryId: string
  title: string
  url: string
  author?: string
  /** 文章时间：采集时标注的原站点发布时间（原始字符串，入库前统一转 ISO 8601） */
  articleTime?: string
  /** 摘要；未提取时由入库层按正文自动生成 */
  summary?: string
  /** 纯文本正文 */
  content?: string
  /**
   * 封面图绝对地址，预留给下游展示使用，**允许为空**。
   *
   * 规则里映射 `cover` / `coverUrl` 字段时取该值；没映射或页面上没有封面时为 `null`。
   */
  coverUrl?: string | null
  metadata?: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/* 请求与代理                                                                  */
/* -------------------------------------------------------------------------- */

/** 请求模式。 */
export const RequestMode = {
  /** 普通 HTTP 请求，速度快，适合服务端渲染页面 */
  HTTP: 'http',
  /** Playwright 渲染，适合 SPA 或依赖脚本的页面 */
  BROWSER: 'browser',
} as const
export type RequestMode = (typeof RequestMode)[keyof typeof RequestMode]

/**
 * 运行时使用的代理配置。
 * 密码只在请求构造时短暂存在，不得写入日志或 API 响应。
 */
export interface ProxySettings {
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
}

/** 等待策略，与 Playwright 的 `waitUntil` 语义一致。 */
export type WaitUntil = 'domcontentloaded' | 'load' | 'networkidle'

/** 一次采集请求的可调参数，规则、任务、栏目都可以覆盖它。 */
export interface CrawlRequestOptions {
  mode?: RequestMode
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** 查询参数，数组会展开为同名多值 */
  query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>
  /** 请求体，仅 POST 生效；对象会被 JSON 序列化 */
  body?: unknown
  /** 阻塞超时（毫秒） */
  timeoutMs?: number
  /** 文本编码；缺省时自动识别 */
  encoding?: string
  /** 失败重试次数，仅对 GET 生效 */
  retries?: number
  /** 响应体大小上限（字节） */
  maxBytes?: number
  /** 重定向次数上限 */
  maxRedirects?: number
  userAgent?: string
  /** Cookie 键值，按 `name=value` 拼接为 Cookie 头 */
  cookies?: Record<string, string>
  /** 浏览器模式：等待条件 */
  waitUntil?: WaitUntil
  /** 浏览器模式：等待到指定选择器出现 */
  waitForSelector?: string
  /** 浏览器模式：是否拦截图片 / 字体 / 媒体资源 */
  blockResources?: boolean
}

/* -------------------------------------------------------------------------- */
/* 上下文                                                                      */
/* -------------------------------------------------------------------------- */

/** 结构化的日志字段，敏感值（代理密码、Cookie、Authorization）不得放入。 */
export type LogFields = Record<string, unknown>

/** 采集日志接口。由应用层注入具体实现，核心包不绑定日志框架。 */
export interface CrawlLogger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/** 网站快照：核心引擎只读取需要的字段，不依赖数据库模型。 */
export interface SiteSnapshot {
  id: string
  name: string
  domain: string
  baseUrl: string
  /** 绑定的站点插件名；为空时使用通用插件 */
  pluginName?: string | null
  status?: string
}

/** 栏目快照。 */
export interface CategorySnapshot {
  id: string
  siteId: string
  name: string
  code?: string | null
  /** 列表页地址 */
  listUrl: string
  enabled?: boolean
}

/** 规则快照：运行时使用的规则配置与版本号。 */
export interface RuleSnapshot {
  id?: string
  version: number
  config: CrawlRuleConfig
}

/**
 * 采集上下文。
 *
 * 插件与解析器都只依赖这个对象：请求、代理、日志、取消信号都由引擎准备好，
 * 插件不直接访问数据库，也不自行创建 HTTP 客户端。
 */
export interface CrawlContext {
  site: SiteSnapshot
  category: CategorySnapshot
  rule: RuleSnapshot
  /** 当前处理的地址（列表页或详情页） */
  url: string
  requestOptions: CrawlRequestOptions
  /** 生效的代理；null 表示直连 */
  proxy: ProxySettings | null
  /** 任务取消信号，贯穿请求、解析与插件调用 */
  signal: AbortSignal
  logger: CrawlLogger
  metadata: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/* 规则结构                                                                    */
/* -------------------------------------------------------------------------- */

/** 字段提取类型。 */
export type FieldType = 'text' | 'html' | 'attr' | 'list' | 'object'

/** 选择器类型。xpath 与 css 走不同适配器，不做字符串转换。 */
export type SelectorType = 'css' | 'xpath'

/** 清理规则：作用在字段值上，按顺序执行。 */
export interface FieldCleanRule {
  /** 去除首尾空白，默认 true */
  trim?: boolean
  /** 折叠连续空白为一个空格 */
  collapseWhitespace?: boolean
  /** 按正则删除匹配内容（全局替换） */
  removePattern?: string
  /** 正则替换，例如把「发布于」去掉 */
  replace?: { pattern: string; with: string }
}

/** 单个字段的提取规则。 */
export interface FieldRule {
  /** 提取类型 */
  type: FieldType
  /** CSS 选择器或 XPath 表达式；object/list 省略时表示当前节点 */
  selector?: string
  /** 选择器类型，默认 css */
  selectorType?: SelectorType
  /** type=attr 时的属性名 */
  attribute?: string
  /** 是否提取多个值；type=list 时始终为数组 */
  multiple?: boolean
  /** 必填校验：缺失时记为该字段失败 */
  required?: boolean
  /** 缺失时的兜底值（字符串） */
  defaultValue?: string
  /** type=object / list 的子字段 */
  fields?: Record<string, FieldRule>
  /** JSON 字段路径，形如 `data.items[0].title`；用于 JSON 响应 */
  jsonPath?: string
  clean?: FieldCleanRule
}

/** 列表页规则。 */
export interface ListRuleConfig {
  /** 列表页地址；省略时使用栏目的 listUrl */
  url?: string
  /** 列表项容器 */
  itemSelector: string
  /** 列表项容器选择器类型 */
  itemSelectorType?: SelectorType
  /**
   * 列表字段配置（推荐写法）：`title` 与 `url` 必填，其余字段自定义。
   * 每个字段支持 `text` / `html` / `attr` 提取类型与默认值；
   * 配置后由 request-pack 的 `html2object`（`loop`）统一解析。
   */
  fields?: Record<string, FieldRule>
  /** 文章链接选择器，默认 `a`（旧版写法，未配置 fields 时仍然生效） */
  linkSelector?: string
  /** 列表标题选择器（旧版写法，未配置 fields 时仍然生效） */
  titleSelector?: string
  /** 链接属性，默认 href */
  linkAttribute?: string
  /** 列表项内封面图选择器；配置后列表阶段即提取封面，详情页没拍到封面时兜底使用 */
  coverSelector?: string
  /** 封面图属性，默认 src（懒加载站点可配 data-src 等真实地址属性） */
  coverAttribute?: string
  /**
   * 列表阶段的解析器插件链：每个列表项字段提取完成后依次执行。
   * 与顶层 `parserPlugins`（详情阶段）互不影响。
   */
  parserPlugins?: string[]
  /**
   * 列表阶段排除选择器：提取字段前先从页面删除命中的节点（混淆 / 广告等）。
   * 优先级最高，先于字段提取与解析器插件执行；可不填。
   */
  excludeSelectors?: string[]
  pagination?: PaginationConfig
}

/** 分页方式。`query` / `path` 由任务执行器实现；`next` / `cursor` 仍为预留。 */
export type PaginationType = 'none' | 'query' | 'path' | 'next' | 'cursor'

/** 分页配置。 */
export interface PaginationConfig {
  type: PaginationType
  /** query 模式的页码参数名 */
  parameter?: string
  /** 起始页码，默认 1 */
  start?: number
  /** 最大页数 */
  maxPages?: number
  /** path 模式的路径模板，如 `/page/{page}` */
  pathPattern?: string
  /** next 模式的下一页链接选择器 */
  nextSelector?: string
  /** cursor 模式的游标参数名 */
  cursorParameter?: string
}

/** 详情页规则。 */
export interface DetailRuleConfig {
  method?: 'GET' | 'POST'
  /** 字段映射；未设置时使用规则顶层的 fields */
  fields?: Record<string, FieldRule>
}

/** 请求阶段的规则配置。 */
export interface RuleRequestConfig {
  mode?: RequestMode
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  timeoutMs?: number
  /**
   * `timeoutMs` 的等价别名，保留是为了兼容规则示例里常见的 `timeout` 写法。
   * 归一化时会被折叠进 `timeoutMs`，入库配置不会同时出现两者。
   */
  timeout?: number
  encoding?: string
  retries?: number
  maxBytes?: number
  maxRedirects?: number
  userAgent?: string
  cookies?: Record<string, string>
  /** 请求级代理覆盖 */
  proxy?: ProxySettings | null
}

/** 清洗规则：针对整篇文章。 */
export interface ContentCleanRule {
  /** 额外移除的选择器（广告、导航等） */
  removeSelectors?: string[]
  /** 保留正文中的图片 */
  keepImages?: boolean
}

/** 校验规则。 */
export interface ValidateConfig {
  /** 全局必填字段，与字段级 required 合并 */
  requiredFields?: string[]
  /** 标题最短长度 */
  minTitleLength?: number
  /** 正文最短长度 */
  minContentLength?: number
}

/** 浏览器阶段的规则配置。 */
export interface BrowserRuleConfig {
  enabled?: boolean
  waitUntil?: WaitUntil
  waitForSelector?: string
  /** 页面加载超时（毫秒） */
  timeoutMs?: number
  blockResources?: boolean
  userAgent?: string
  viewport?: { width: number; height: number }
}

/**
 * 采集规则。
 *
 * 以 JSON 存储，第三阶段会在此基础上增加 Schema 校验、版本与继承；
 * 第二阶段只使用 request / list / detail / fields / clean / validate 这几部分。
 */
export interface CrawlRuleConfig {
  version: number
  request?: RuleRequestConfig
  list?: ListRuleConfig
  /** 生效的分页配置（由 list.pagination 归一化而来） */
  pagination?: PaginationConfig
  detail?: DetailRuleConfig
  fields?: Record<string, FieldRule>
  /**
   * 详情阶段的解析器插件链：详情字段提取完成后依次执行，
   * 用于重格式化数据（如图片地址解密）。与 `list.parserPlugins` 互不影响。
   */
  parserPlugins?: string[]
  /**
   * 详情阶段排除选择器：提取字段前先从页面删除命中的节点（混淆 / 广告等）。
   * 优先级最高，先于字段提取与解析器插件执行；可不填。
   */
  excludeSelectors?: string[]
  clean?: ContentCleanRule
  validate?: ValidateConfig
  browser?: BrowserRuleConfig
}
