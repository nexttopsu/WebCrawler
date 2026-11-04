import { apiRequest } from './http'
import type {
  DetailTestRequestBody,
  ListTestRequestBody,
  PageSnapshotDto,
  PaginatedData,
  RuleValidationDto,
  RuleDto,
  RuleSummaryDto,
  CategorySummaryDto,
  SiteDto,
  SnapshotRequestBody,
  TesterDetailResultDto,
  TesterListResultDto,
} from '@webcrawler/shared'

/** 代理摘要（服务端只暴露协议/主机/端口，凭据不出 DTO）。 */
export interface ProxyItem {
  id: number
  protocol: string
  host: string
  port: number
  status: string
}

/* ------------------------------ 测试器接口 ------------------------------ */

/** 获取页面快照（HTML 已在服务端清洗，前端必须放 sandboxed iframe）。 */
export function fetchSnapshot(body: SnapshotRequestBody): Promise<PageSnapshotDto> {
  return apiRequest<PageSnapshotDto>('/tester/snapshot', { method: 'POST', body: JSON.stringify(body) })
}

/** 用未保存的列表规则跑一次真实列表提取。 */
export function testListRule(body: ListTestRequestBody): Promise<TesterListResultDto> {
  return apiRequest<TesterListResultDto>('/tester/list', { method: 'POST', body: JSON.stringify(body) })
}

/** 用未保存的字段映射跑一次真实详情解析。 */
export function testDetailRule(body: DetailTestRequestBody): Promise<TesterDetailResultDto> {
  return apiRequest<TesterDetailResultDto>('/tester/detail', { method: 'POST', body: JSON.stringify(body) })
}


/** 用第三阶段 Rule Schema 校验完整规则 JSON。 */
export function validateRuleConfig(config: unknown): Promise<RuleValidationDto> {
  return apiRequest<RuleValidationDto>('/tester/rule/validate', {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
}

/* ------------------------------ 规则保存 ------------------------------ */

/** 保存为新规则（草稿转正式时调用）。 */
export function createRule(input: { siteId: number; categoryId?: number; name: string; config: unknown; description?: string }): Promise<RuleDto> {
  return apiRequest<RuleDto>('/rules', { method: 'POST', body: JSON.stringify(input) })
}

/** 更新已有规则（配置变化时服务端自动 version+1）。 */
export function updateRule(id: number, input: { name?: string; config?: unknown; description?: string }): Promise<RuleDto> {
  return apiRequest<RuleDto>(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
}

/** 站点列表（保存规则时选择关联网站）。 */
export function listSites(keyword?: string): Promise<PaginatedData<SiteDto>> {
  const query = keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''
  return apiRequest<PaginatedData<SiteDto>>(`/sites${query}`)
}

/** 栏目列表（按站点过滤）。 */
export function listCategories(siteId: number): Promise<PaginatedData<CategorySummaryDto>> {
  return apiRequest<PaginatedData<CategorySummaryDto>>(`/categories?siteId=${siteId}&pageSize=100`)
}

/** 规则列表（更新已有规则时选择目标）。 */
export function listRules(siteId?: number): Promise<PaginatedData<RuleSummaryDto>> {
  const query = siteId ? `?siteId=${siteId}&pageSize=100` : '?pageSize=100'
  return apiRequest<PaginatedData<RuleSummaryDto>>(`/rules${query}`)
}

/* ------------------------------ 代理（只读） ------------------------------ */

/** 代理只读列表：完整管理在第五阶段提供。 */
export function listProxies(): Promise<{ items: ProxyItem[]; total: number }> {
  return apiRequest<{ items: ProxyItem[]; total: number }>('/proxies')
}
