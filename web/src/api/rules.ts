import type {
  CrawlRuleStatus,
  DeleteResultDto,
  EffectiveRuleDto,
  PaginatedData,
  RuleDto,
  RuleVersionDetailDto,
  RuleVersionDto,
  RuleValidationDto,
} from '@webcrawler/shared'
import { api } from './client'

export interface RuleListParams {
  page?: number
  pageSize?: number
  siteId?: number
  categoryId?: number
  status?: CrawlRuleStatus
  scope?: 'site' | 'category'
  keyword?: string
}

export interface RuleInput {
  siteId: number
  categoryId?: number | null
  name: string
  config: unknown
  description?: string | null
}

export function listRules(params: RuleListParams = {}): Promise<PaginatedData<RuleDto>> {
  return api.get<PaginatedData<RuleDto>>('/rules', params)
}

export function getRule(id: number): Promise<RuleDto> {
  return api.get<RuleDto>(`/rules/${id}`)
}

export function createRule(input: RuleInput): Promise<RuleDto> {
  return api.post<RuleDto>('/rules', input)
}

export function updateRule(id: number, input: RuleInput): Promise<RuleDto> {
  return api.put<RuleDto>(`/rules/${id}`, input)
}

export function patchRule(id: number, input: Partial<RuleInput>): Promise<RuleDto> {
  return api.patch<RuleDto>(`/rules/${id}`, input)
}

export function deleteRule(id: number, force = false): Promise<DeleteResultDto> {
  return api.delete<DeleteResultDto>(`/rules/${id}`, force ? { force: 'true' } : undefined)
}

export function setRuleStatus(id: number, status: CrawlRuleStatus): Promise<RuleDto> {
  return api.patch<RuleDto>(`/rules/${id}/status`, { status })
}

export function listRuleVersions(id: number): Promise<{ items: RuleVersionDto[] }> {
  return api.get<{ items: RuleVersionDto[] }>(`/rules/${id}/versions`)
}

export function getRuleVersion(id: number, version: number): Promise<RuleVersionDetailDto> {
  return api.get<RuleVersionDetailDto>(`/rules/${id}/versions/${version}`)
}

/** 解析生效规则（站点默认 → 栏目 → 任务覆盖）。 */
export function resolveRule(input: {
  siteId: number
  categoryId?: number
  override?: unknown
}): Promise<EffectiveRuleDto> {
  return api.post<EffectiveRuleDto>('/rules/resolve', input)
}

/** 用已保存的规则试采一次。 */
export function testRule(id: number, listUrl?: string): Promise<unknown> {
  return api.post<unknown>(`/rules/${id}/test`, listUrl ? { listUrl } : {})
}

/** 用 Rule Schema 校验规则 JSON（导入时预检，错误可定位到字段）。 */
export function validateRuleConfig(config: unknown): Promise<RuleValidationDto> {
  return api.post<RuleValidationDto>('/tester/rule/validate', { config })
}
