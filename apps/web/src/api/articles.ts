import type {
  ArticleCollectDetailResultDto,
  ArticleDeleteResultDto,
  ArticleDto,
  ArticleRawDto,
  ArticleSummaryDto,
  PaginatedData,
} from '@webcrawler/shared'
import { api, saveBlob } from './client'

export interface ArticleListParams {
  page?: number
  pageSize?: number
  keyword?: string
  siteId?: number
  categoryId?: number
  taskId?: number
  /** 详情采集状态：pending（仅列表入库）/ collected（已采集）/ failed（失败） */
  detailStatus?: 'pending' | 'collected' | 'failed'
  articleTimeFrom?: string
  articleTimeTo?: string
  createdFrom?: string
  createdTo?: string
  sort?: 'articleTime' | 'createdAt' | 'id'
  order?: 'asc' | 'desc'
}

export function listArticles(params: ArticleListParams = {}): Promise<PaginatedData<ArticleSummaryDto>> {
  return api.get<PaginatedData<ArticleSummaryDto>>('/articles', params)
}

export function getArticle(id: number): Promise<ArticleDto> {
  return api.get<ArticleDto>(`/articles/${id}`)
}

export function getArticleRaw(id: number): Promise<ArticleRawDto> {
  return api.get<ArticleRawDto>(`/articles/${id}/raw`)
}

/**
 * 编辑文章的采集内容字段。
 *
 * 服务端 Schema 是白名单式的：只有标题、作者、摘要、正文、封面、文章时间
 * 可以改；siteId / categoryId / url / detailStatus 等归属与状态字段传了会 400。
 */
export interface ArticleUpdatePayload {
  title?: string
  author?: string | null
  summary?: string | null
  content?: string | null
  coverUrl?: string | null
  articleTime?: string | null
}

export function updateArticle(id: number, payload: ArticleUpdatePayload): Promise<ArticleDto> {
  return api.patch<ArticleDto>(`/articles/${id}`, payload)
}

export function deleteArticle(id: number): Promise<ArticleDeleteResultDto> {
  return api.delete<ArticleDeleteResultDto>(`/articles/${id}`)
}

export function deleteArticles(ids: number[]): Promise<ArticleDeleteResultDto> {
  return api.post<ArticleDeleteResultDto>('/articles/batch-delete', { ids })
}

export interface CollectDetailParams {
  /** 勾选的文章 id；与筛选条件二选一，同时给出时以 id 为准 */
  ids?: number[]
  siteId?: number
  categoryId?: number
  keyword?: string
  /** 单次最多补采多少篇，默认 200 */
  limit?: number
}

/**
 * 补采详情。
 *
 * 服务端会按「站点 + 栏目」拆成若干 detail 任务并立即入队，
 * 返回创建的 taskId；进度到采集任务页查看。
 */
export function collectArticleDetail(
  params: CollectDetailParams,
): Promise<ArticleCollectDetailResultDto> {
  return api.post<ArticleCollectDetailResultDto>('/articles/collect-detail', params)
}

/**
 * 导出文章。
 *
 * 服务端是流式响应并限制单次条数（默认 1000，上限 5000）；
 * 这里直接触发浏览器下载，不在前端拼大数组。
 */
export async function exportArticles(
  params: ArticleListParams,
  format: 'json' | 'csv',
  limit = 1000,
): Promise<void> {
  const { blob, filename } = await api.download('/articles/export', { ...params, format, limit })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  saveBlob(blob, filename ?? `articles-${stamp}.${format}`)
}
