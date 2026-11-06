import type {
  CategoryDetailDto,
  CategoryDto,
  CategorySummaryDto,
  CategoryTestDto,
  CategoryTreeNodeDto,
  DeleteResultDto,
  PaginatedData,
} from '@webcrawler/shared'
import { api } from './client'

export interface CategoryListParams {
  page?: number
  pageSize?: number
  siteId?: number
  keyword?: string
  enabled?: 'true' | 'false'
}

export interface CategoryInput {
  siteId: number
  parentId?: number | null
  name: string
  code?: string | null
  listUrl: string
  ruleId?: number | null
  proxyId?: number | null
  enabled?: boolean
  crawlInterval?: number
  sortOrder?: number
  description?: string | null
}

export function listCategories(params: CategoryListParams = {}): Promise<PaginatedData<CategoryDto>> {
  return api.get<PaginatedData<CategoryDto>>('/categories', params)
}

/** 栏目树：一次取回全部栏目（可按站点收窄），层级由 `children` 嵌套表达。 */
export function listCategoryTree(siteId?: number): Promise<CategoryTreeNodeDto[]> {
  return api.get<CategoryTreeNodeDto[]>('/categories/tree', siteId ? { siteId } : undefined)
}

export function listSiteCategories(siteId: number): Promise<PaginatedData<CategorySummaryDto>> {
  return api.get<PaginatedData<CategorySummaryDto>>(`/sites/${siteId}/categories`)
}

export function getCategory(id: number): Promise<CategoryDetailDto> {
  return api.get<CategoryDetailDto>(`/categories/${id}`)
}

export function createCategory(input: CategoryInput): Promise<CategoryDto> {
  return api.post<CategoryDto>('/categories', input)
}

export function updateCategory(id: number, input: CategoryInput): Promise<CategoryDto> {
  return api.put<CategoryDto>(`/categories/${id}`, input)
}

export function patchCategory(id: number, input: Partial<CategoryInput>): Promise<CategoryDto> {
  return api.patch<CategoryDto>(`/categories/${id}`, input)
}

export function deleteCategory(id: number, force = false): Promise<DeleteResultDto> {
  return api.delete<DeleteResultDto>(`/categories/${id}`, force ? { force: 'true' } : undefined)
}

export function setCategoryEnabled(id: number, enabled: boolean): Promise<CategoryDto> {
  return api.patch<CategoryDto>(`/categories/${id}/status`, { enabled })
}

/** 单栏目试采：走与正式采集同一套引擎，抓一次列表页。 */
export function testCategory(id: number): Promise<CategoryTestDto> {
  return api.post<CategoryTestDto>(`/categories/${id}/test`)
}
