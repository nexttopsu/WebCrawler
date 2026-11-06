import type { CrawlRuleConfig } from './crawl.js'
import type { CrawlRuleStatus, SiteStatus } from './domain.js'

/**
 * 管理 API 的数据传输对象。
 *
 * 服务端把数据库行（含可空字段、0/1 布尔）映射成这里的结构，
 * 前端与测试都只依赖这些类型，不直接接触 ORMlet 的行类型。
 */

/** 代理摘要：不包含用户名与密码。 */
export interface ProxySummaryDto {
  id: number
  protocol: string
  host: string
  port: number
  status: string
}

/** 规则摘要。 */
export interface RuleSummaryDto {
  id: number
  name: string
  version: number
  status: CrawlRuleStatus
}

/** 网站。 */
export interface SiteDto {
  id: number
  name: string
  domain: string
  baseUrl: string
  pluginName: string | null
  defaultProxyId: number | null
  status: SiteStatus
  description: string | null
  createdAt: string
  updatedAt: string
}

/** 网站详情：附带关联计数与默认规则。 */
export interface SiteDetailDto extends SiteDto {
  defaultRule: RuleSummaryDto | null
  counts: {
    categories: number
    rules: number
    tasks: number
    articles: number
  }
}

/** 网站所属栏目的精简结构。 */
export interface CategorySummaryDto {
  id: number
  name: string
  code: string | null
  listUrl: string
  enabled: boolean
  ruleId: number | null
  crawlInterval: number
}

/** 栏目。 */
export interface CategoryDto {
  id: number
  siteId: number
  name: string
  /**
   * 上级栏目 id；`null` 表示顶级栏目。
   *
   * 层级只用于组织与展示：父栏目本身也是可采集的真实栏目，
   * 选中父栏目时只作用于它自己，不包含子栏目。
   */
  parentId: number | null
  code: string | null
  listUrl: string
  ruleId: number | null
  proxyId: number | null
  enabled: boolean
  /** 自动采集间隔（秒）；0 表示不自动采集 */
  crawlInterval: number
  sortOrder: number
  description: string | null
  createdAt: string
  updatedAt: string
}

/** 栏目树节点：`children` 为直接子栏目，叶子为空数组。 */
export interface CategoryTreeNodeDto extends CategoryDto {
  children: CategoryTreeNodeDto[]
}

/** 栏目详情：附带站点、规则与代理摘要。 */
export interface CategoryDetailDto extends CategoryDto {
  site: { id: number; name: string; domain: string }
  rule: RuleSummaryDto | null
  proxy: ProxySummaryDto | null
}

/** 采集规则。 */
export interface RuleDto {
  id: number
  siteId: number
  categoryId: number | null
  name: string
  /** 规则修订号，每次配置变更 +1 */
  version: number
  status: CrawlRuleStatus
  description: string | null
  /** 规则结构版本，当前为 1 */
  configVersion: number
  config: CrawlRuleConfig
  createdAt: string
  updatedAt: string
}

/** 规则版本记录。 */
export interface RuleVersionDto {
  ruleId: number
  version: number
  note: string | null
  createdAt: string
}

/** 规则版本详情：附带完整配置。 */
export interface RuleVersionDetailDto extends RuleVersionDto {
  config: CrawlRuleConfig
}

/** 生效规则的来源。`ruleId` 为 null 表示任务临时覆盖（不落库）。 */
export interface RuleSourceDto {
  scope: 'site' | 'category' | 'task'
  ruleId: number | null
  name: string
  version: number
}

/** 合并后的生效规则。 */
export interface EffectiveRuleDto {
  siteId: number
  categoryId: number | null
  /** 合并结果；没有任何来源时为 null */
  config: CrawlRuleConfig | null
  /** 实际生效的分页类型，便于前端提示哪些类型尚不可执行 */
  paginationType: string | null
  sources: RuleSourceDto[]
  /** 合并策略说明，随响应返回，避免文档与实现脱节 */
  mergeStrategy: readonly string[]
}

/** 网站连接测试结果。 */
export interface SiteConnectionTestDto {
  ok: boolean
  url: string
  finalUrl: string | null
  statusCode: number | null
  elapsedMs: number
  contentType: string | null
  title: string | null
  message: string
}

/** 栏目列表测试结果（第四阶段的可视化测试器会复用同一套服务）。 */
export interface CategoryTestDto {
  ok: boolean
  url: string
  finalUrl: string | null
  statusCode: number | null
  elapsedMs: number
  mode: 'http' | 'browser'
  /** 列表项命中数量 */
  itemCount: number
  linkCount: number
  /** 去重后的前若干条链接，供界面预览 */
  links: Array<{ url: string; title: string | null }>
  message: string
}

/** 删除操作的结果。 */
export interface DeleteResultDto {
  id: number
  deleted: boolean
  /** 被一并处理（解除引用）的关联记录数 */
  detached?: number
}
