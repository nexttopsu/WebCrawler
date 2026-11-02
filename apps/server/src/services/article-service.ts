import {
  getDatabaseContext,
  getModels,
  type ArticleRow,
} from '@webcrawler/database'
import {
  normalizeArticleUrl,
  type ArticleData,
  type ArticleDeleteResultDto,
  type ArticleDto,
  type ArticleRawDto,
  type ArticleStatus,
  type ArticleSummaryDto,
} from '@webcrawler/shared'
import { z } from 'zod'
import { BadRequestError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'

/** 原始 HTML 的存储上限：超过 512 KB 只保留前 512 KB，避免单篇文章撑爆数据库。 */
const RAW_HTML_MAX = 512 * 1024
/** 扩展字段 JSON 上限。 */
const EXTRA_MAX = 16 * 1024
/** 批量删除单次上限。 */
export const BATCH_DELETE_MAX = 100
/** 导出单次上限，避免一次性把整库读进内存。 */
export const EXPORT_MAX = 5000
export const EXPORT_DEFAULT = 1000
/** 导出分批读取的批大小。 */
const EXPORT_BATCH = 200

/* -------------------------------------------------------------------------- */
/* 写入                                                                        */
/* -------------------------------------------------------------------------- */

export interface SaveArticleOptions {
  dedupeByContentHash?: boolean
  publishedAfter?: string
  publishedBefore?: string
}

export type SaveOutcomeStatus = 'created' | 'updated' | 'skipped'

export interface SaveOutcome {
  status: SaveOutcomeStatus
  articleId?: number
  /** skipped 时的原因，用于日志与统计 */
  reason?: string
}

/** 把各种写法的发布时间转成 ISO；解析失败返回 null（不阻塞入库）。 */
export function toIsoTime(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value) return null
  // `2026-01-02 10:30` 这类写法在 Node 中按本地时间解析
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(' ', 'T') : value
  const timestamp = Date.parse(normalized)
  if (Number.isNaN(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function countWords(content: string): number {
  // 中日韩按字符计，其余按空白分词；两者相加，避免中文文章词数为 0
  const cjk = content.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const words = content.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').trim()
  const latin = words ? words.split(/\s+/).length : 0
  return cjk + latin
}

function buildSummary(content: string): string | null {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

function clampJson(value: unknown, max = EXTRA_MAX): string {
  try {
    const text = JSON.stringify(value ?? null)
    return text.length > max ? text.slice(0, max) : text
  } catch {
    return 'null'
  }
}

/**
 * 保存一篇采集到的文章。
 *
 * 去重顺序：
 * 1. 同一 URL 已存在：内容 Hash 相同 → skipped（未变化）；
 *    不同 → updated（保留 id 与创建时间，更新正文与时间）。
 * 2. 内容 Hash 命中其他 URL → skipped（转载/聚合重复）。
 * 3. 其余 → created。
 *
 * 数据库唯一约束 `ux_article_url` 是最后一道防线：并发写入同一 URL 时
 * 第二个写入会抛唯一约束错误，由调用方按「已存在」处理。
 */
export function saveCrawledArticle(
  input: {
    article: ArticleData
    siteId: number
    categoryId: number | null
    taskId: number | null
    rawHtml?: string | null
  },
  options: SaveArticleOptions = {},
): SaveOutcome {
  const { article } = input
  const models = getModels()
  const url = normalizeArticleUrl(article.url)
  const publishedAt = toIsoTime(article.publishTime)

  if (options.publishedAfter && publishedAt && publishedAt < options.publishedAfter) {
    return { status: 'skipped', reason: `发布时间 ${publishedAt} 早于任务窗口` }
  }
  if (options.publishedBefore && publishedAt && publishedAt > options.publishedBefore) {
    return { status: 'skipped', reason: `发布时间 ${publishedAt} 晚于任务窗口` }
  }

  const content = article.content ?? ''
  const html = article.html ?? ''
  const images = article.images ?? []
  const metadata = { ...(article.metadata ?? {}) }
  delete metadata.sourceUrl
  delete metadata.listTitle

  const fields = {
    siteId: input.siteId,
    categoryId: input.categoryId,
    taskId: input.taskId,
    title: article.title.trim(),
    url,
    author: article.author ?? null,
    summary: buildSummary(content),
    content,
    contentHtml: html,
    coverUrl: images[0] ?? null,
    images: clampJson(images),
    contentHash: article.contentHash ?? null,
    wordCount: countWords(content),
    publishedAt,
    status: 'published' as ArticleStatus,
    extra: clampJson(metadata),
    crawlTime: article.crawlTime ?? new Date().toISOString(),
    ...(input.rawHtml ? { rawHtml: input.rawHtml.slice(0, RAW_HTML_MAX) } : {}),
  }

  const existing = models.article.findOne({ url })

  if (existing) {
    if (existing.contentHash && article.contentHash && existing.contentHash === article.contentHash) {
      return { status: 'skipped', articleId: existing.id, reason: '内容未变化' }
    }
    models.article.update(existing.id, fields)
    return { status: 'updated', articleId: existing.id }
  }

  if (options.dedupeByContentHash !== false && article.contentHash) {
    const duplicate = models.article.findOne({ contentHash: article.contentHash })
    if (duplicate) {
      return {
        status: 'skipped',
        articleId: duplicate.id,
        reason: `与已有文章 ${duplicate.id} 内容重复`,
      }
    }
  }

  const created = models.article.create(fields)
  return { status: 'created', articleId: created.id }
}

/** 增量判断：URL 是否已存在。 */
export function findArticleIdByUrl(rawUrl: string): number | null {
  const url = normalizeArticleUrl(rawUrl)
  return getModels().article.findOne({ url })?.id ?? null
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                        */
/* -------------------------------------------------------------------------- */

const isoTimeField = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), '时间格式不合法，请使用 ISO 8601')
  .transform((value) => new Date(value).toISOString())

export const articleListQuerySchema = z.object({
  ...paginationFields,
  keyword: keywordField,
  siteId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  taskId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'published', 'ignored']).optional(),
  publishedFrom: isoTimeField.optional(),
  publishedTo: isoTimeField.optional(),
  crawledFrom: isoTimeField.optional(),
  crawledTo: isoTimeField.optional(),
  sort: z.enum(['id', 'publishedAt', 'crawlTime']).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type ArticleListQuery = z.infer<typeof articleListQuerySchema>

interface WhereParts {
  conditions: string[]
  params: Array<string | number>
}

function buildWhere(query: Omit<ArticleListQuery, 'page' | 'pageSize' | 'sort' | 'order'>): WhereParts {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.siteId) {
    conditions.push('t.siteId = ?')
    params.push(query.siteId)
  }
  if (query.categoryId) {
    conditions.push('t.categoryId = ?')
    params.push(query.categoryId)
  }
  if (query.taskId) {
    conditions.push('t.taskId = ?')
    params.push(query.taskId)
  }
  if (query.status) {
    conditions.push('t.status = ?')
    params.push(query.status)
  }
  if (query.keyword) {
    conditions.push(
      "(t.title LIKE ? ESCAPE '\\' OR t.summary LIKE ? ESCAPE '\\' OR t.content LIKE ? ESCAPE '\\')",
    )
    const pattern = likePattern(query.keyword)
    params.push(pattern, pattern, pattern)
  }
  if (query.publishedFrom) {
    conditions.push('t.publishedAt >= ?')
    params.push(query.publishedFrom)
  }
  if (query.publishedTo) {
    conditions.push('t.publishedAt <= ?')
    params.push(query.publishedTo)
  }
  if (query.crawledFrom) {
    conditions.push('t.crawlTime >= ?')
    params.push(query.crawledFrom)
  }
  if (query.crawledTo) {
    conditions.push('t.crawlTime <= ?')
    params.push(query.crawledTo)
  }

  return { conditions, params }
}

/** 列表不返回正文与原始 HTML，但保留 images 以便统计图片数。 */
const SUMMARY_COLUMNS =
  't.id, t.siteId, t.categoryId, t.taskId, t.title, t.url, t.author, t.summary, t.coverUrl, t.publishedAt, t.status, t.contentHash, t.images, t.wordCount, t.crawlTime, t.createdAt, t.updatedAt'

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

type SummaryRow = Pick<
  ArticleRow,
  | 'id'
  | 'siteId'
  | 'categoryId'
  | 'taskId'
  | 'title'
  | 'url'
  | 'author'
  | 'summary'
  | 'coverUrl'
  | 'publishedAt'
  | 'status'
  | 'contentHash'
  | 'images'
  | 'wordCount'
  | 'crawlTime'
  | 'createdAt'
  | 'updatedAt'
>

function toSummaryDto(row: SummaryRow): ArticleSummaryDto {
  return {
    id: row.id,
    siteId: row.siteId ?? 0,
    categoryId: row.categoryId,
    taskId: row.taskId,
    title: row.title ?? '',
    url: row.url ?? '',
    author: row.author,
    summary: row.summary,
    coverUrl: row.coverUrl,
    publishedAt: row.publishedAt,
    status: (row.status ?? 'published') as ArticleStatus,
    contentHash: row.contentHash,
    wordCount: row.wordCount ?? 0,
    imageCount: parseStringArray(row.images).length,
    crawlTime: row.crawlTime,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

export function listArticles(query: ArticleListQuery) {
  const { conditions, params } = buildWhere(query)
  const sortColumn = query.sort === 'publishedAt' ? 't.publishedAt' : query.sort === 'crawlTime' ? 't.crawlTime' : 't.id'
  const direction = query.order === 'asc' ? 'ASC' : 'DESC'

  const { rows, total } = runRawList<SummaryRow>(getDatabaseContext().db, {
    select: SUMMARY_COLUMNS,
    from: 'article t',
    conditions,
    params,
    orderBy: `${sortColumn} ${direction}, t.id ${direction}`,
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toSummaryDto), total, query.page, query.pageSize)
}

function parseExtra(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function getArticle(id: number): ArticleDto {
  const models = getModels()
  const row = models.article.findById(id)
  if (!row) throw new NotFoundError(`文章 ${id} 不存在`)

  const site = row.siteId ? models.site.findById(row.siteId) : null
  const category = row.categoryId ? models.category.findById(row.categoryId) : null

  return {
    ...toSummaryDto({ ...row, images: row.images } as SummaryRow),
    content: row.content,
    contentHtml: row.contentHtml,
    images: parseStringArray(row.images),
    extra: parseExtra(row.extra),
    siteName: site?.name ?? null,
    categoryName: category?.name ?? null,
  }
}

/** 原始 HTML；未保存原始 HTML 时明确返回空串而不是伪造内容。 */
export function getArticleRaw(id: number): ArticleRawDto {
  const row = getModels().article.findById(id)
  if (!row) throw new NotFoundError(`文章 ${id} 不存在`)
  return {
    id: row.id,
    url: row.url ?? '',
    html: row.rawHtml ?? '',
    crawlTime: row.crawlTime,
  }
}

export function deleteArticle(id: number): { deleted: boolean } {
  const models = getModels()
  if (!models.article.exists({ id })) throw new NotFoundError(`文章 ${id} 不存在`)
  models.article.delete(id)
  return { deleted: true }
}

/** 批量删除：单次上限 100，缺失的 id 单独返回。 */
export function deleteArticles(ids: number[]): ArticleDeleteResultDto {
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new BadRequestError('ids 不能为空')
  if (unique.length > BATCH_DELETE_MAX) {
    throw new ValidationError(`单次最多删除 ${BATCH_DELETE_MAX} 篇文章`, [
      { path: 'ids', message: `最多 ${BATCH_DELETE_MAX} 个`, code: 'too_big' },
    ])
  }

  const models = getModels()
  const missing: number[] = []
  let deleted = 0
  for (const id of unique) {
    if (!models.article.exists({ id })) {
      missing.push(id)
      continue
    }
    models.article.delete(id)
    deleted += 1
  }
  return { deleted, missing }
}

/* -------------------------------------------------------------------------- */
/* 导出                                                                        */
/* -------------------------------------------------------------------------- */

export interface ArticleExport {
  stream: ReadableStream<Uint8Array>
  filename: string
  contentType: string
}

const CSV_HEADERS = [
  'id',
  'title',
  'url',
  'siteId',
  'categoryId',
  'taskId',
  'author',
  'publishedAt',
  'crawlTime',
  'contentHash',
  'wordCount',
  'imageCount',
  'status',
  'summary',
  'content',
] as const

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

function timestampSuffix(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 流式导出。
 *
 * 按 `EXPORT_BATCH` 分批查询并生成 chunk，内存中同时只有一批数据；
 * 总数通过 `limit` 硬性限制，避免一次导出拖垮进程。
 */
export function exportArticles(
  query: ArticleListQuery,
  format: 'json' | 'csv',
  limit: number,
): ArticleExport {
  const capped = Math.min(Math.max(1, limit), EXPORT_MAX)
  const { conditions, params } = buildWhere(query)
  const db = getDatabaseContext().db
  const orderBy = 't.id DESC'

  const encoder = new TextEncoder()
  let offset = 0
  let emitted = 0
  let first = true

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (format === 'csv') controller.enqueue(encoder.encode(`\uFEFF${csvLine([...CSV_HEADERS])}`))
      else controller.enqueue(encoder.encode('['))
    },
    pull(controller) {
      if (emitted >= capped) {
        if (format === 'json') controller.enqueue(encoder.encode(']'))
        controller.close()
        return
      }

      const pageSize = Math.min(EXPORT_BATCH, capped - emitted)
      const where = conditions.length > 0 ? conditions.join(' AND ') : '1 = 1'
      // 直接带 LIMIT/OFFSET：分页页大小在最后一批会变化，不能复用按页计算的 helper
      const rows = db
        .prepare(
          `SELECT id, title, url, siteId, categoryId, taskId, author, publishedAt, crawlTime, contentHash, wordCount, images, status, summary, content, contentHtml, extra
           FROM article t WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset) as unknown as ArticleRow[]

      if (rows.length === 0) {
        if (format === 'json') controller.enqueue(encoder.encode(']'))
        controller.close()
        return
      }

      offset += rows.length
      emitted += rows.length

      if (format === 'csv') {
        const lines = rows
          .map((row) =>
            csvLine([
              row.id,
              row.title,
              row.url,
              row.siteId,
              row.categoryId,
              row.taskId,
              row.author,
              row.publishedAt,
              row.crawlTime,
              row.contentHash,
              row.wordCount,
              parseStringArray(row.images).length,
              row.status,
              row.summary,
              row.content,
            ]),
          )
          .join('')
        controller.enqueue(encoder.encode(lines))
      } else {
        const payload = rows.map((row) => ({
          id: row.id,
          title: row.title,
          url: row.url,
          siteId: row.siteId,
          categoryId: row.categoryId,
          taskId: row.taskId,
          author: row.author,
          publishedAt: row.publishedAt,
          crawlTime: row.crawlTime,
          contentHash: row.contentHash,
          wordCount: row.wordCount,
          status: row.status,
          summary: row.summary,
          content: row.content,
          contentHtml: row.contentHtml,
          images: parseStringArray(row.images),
          extra: parseExtra(row.extra),
        }))
        const text = `${first ? '' : ','}${JSON.stringify(payload).slice(1, -1)}`
        first = false
        controller.enqueue(encoder.encode(text))
      }

      if (emitted >= capped) {
        if (format === 'json') controller.enqueue(encoder.encode(']'))
        controller.close()
      }
    },
  })

  return {
    stream,
    filename: `articles-${timestampSuffix()}.${format}`,
    contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
  }
}
