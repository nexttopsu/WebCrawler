import type {
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
  status?: string
  publishedFrom?: string
  publishedTo?: string
  crawledFrom?: string
  crawledTo?: string
  sort?: 'publishedAt' | 'crawlTime' | 'id'
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

export function deleteArticle(id: number): Promise<ArticleDeleteResultDto> {
  return api.delete<ArticleDeleteResultDto>(`/articles/${id}`)
}

export function deleteArticles(ids: number[]): Promise<ArticleDeleteResultDto> {
  return api.post<ArticleDeleteResultDto>('/articles/batch-delete', { ids })
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
