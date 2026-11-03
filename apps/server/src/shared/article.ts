import type { ArticleStatus } from './domain.js'

/**
 * 文章数据的管理侧契约。
 *
 * 采集引擎输出 `ArticleData`（结构由规则决定），落库时补上站点、栏目、
 * 任务归属与去重字段，读取时再映射成下面的结构。
 */

/** 列表项：不返回正文，避免列表接口体积过大。 */
export interface ArticleSummaryDto {
  id: number
  siteId: number
  categoryId: number | null
  taskId: number | null
  title: string
  url: string
  author: string | null
  summary: string | null
  /** 封面图地址；预留字段，可为 null（无封面时不报错、不占位） */
  coverUrl: string | null
  publishedAt: string | null
  status: ArticleStatus
  contentHash: string | null
  wordCount: number
  imageCount: number
  crawlTime: string | null
  createdAt: string
  updatedAt: string
}

/** 详情：包含正文、原始 HTML、图片与扩展字段。 */
export interface ArticleDto extends ArticleSummaryDto {
  /** 纯文本正文 */
  content: string | null
  /** 清洗后的正文 HTML */
  contentHtml: string | null
  /** 正文图片绝对地址 */
  images: string[]
  /** 规则未映射到标准字段的其余字段 */
  extra: Record<string, unknown>
  /** 站点名称，仅详情返回，便于展示 */
  siteName: string | null
  categoryName: string | null
}

/** 原始 HTML 查看结果。 */
export interface ArticleRawDto {
  id: number
  url: string
  html: string
  /** 抓取到该 HTML 的时间 */
  crawlTime: string | null
}

/** 批量删除结果。 */
export interface ArticleDeleteResultDto {
  deleted: number
  /** 请求中不存在或已被删除的 id */
  missing: number[]
}
