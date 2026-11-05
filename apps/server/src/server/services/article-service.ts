import {
  getDatabaseContext,
  getModels,
  type ArticleRow,
} from '../../database/index.js'
import {
  ArticleDetailStatus,
  normalizeArticleUrl,
  type ArticleData,
  type ArticleDeleteResultDto,
  type ArticleDto,
  type ArticleRawDto,
  type ArticleSummaryDto,
} from '../../shared/index.js'
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
  /** 只保留文章时间晚于该值的文章（增量采集窗口） */
  articleTimeAfter?: string
  /** 只保留文章时间早于该值的文章（增量采集窗口） */
  articleTimeBefore?: string
}

export type SaveOutcomeStatus = 'created' | 'updated' | 'skipped'

export interface SaveOutcome {
  status: SaveOutcomeStatus
  articleId?: number
  /** skipped 时的原因，用于日志与统计 */
  reason?: string
}

/** 把各种写法的文章时间（原站点发布时间）转成 ISO；解析失败返回 null（不阻塞入库）。 */
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
 * 封面图地址归一化。
 *
 * 封面是预留字段、允许为空：显式给了就优先用它（相对地址按文章地址补全），
 * 没给（null / 空串）则返回 null。
 * 只接受 http(s)，避免把 `javascript:` 这类伪协议带进前端。
 */
function resolveCoverUrl(raw: string | null | undefined, baseUrl: string): string | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const candidate = new URL(value, baseUrl).toString()
    return /^https?:\/\//i.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * 读取文章时间并归一化为 ISO。
 *
 * 管道输出统一用 `articleTime`；外部插件可能仍按旧契约返回 `publishTime`，
 * 这里兼容读取一次，避免旧插件给出的时间被静默丢弃。
 */
function readArticleTime(article: ArticleData): string | null {
  const legacy = (article as ArticleData & { publishTime?: string }).publishTime
  return toIsoTime(article.articleTime) ?? toIsoTime(legacy)
}

/**
 * 保存一篇采集到的文章。
 *
 * 去重：同一 URL 已存在时按「已存在」更新（保留 id 与创建时间）。
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
  const articleTime = readArticleTime(article)

  if (options.articleTimeAfter && articleTime && articleTime < options.articleTimeAfter) {
    return { status: 'skipped', reason: `文章时间 ${articleTime} 早于任务窗口` }
  }
  if (options.articleTimeBefore && articleTime && articleTime > options.articleTimeBefore) {
    return { status: 'skipped', reason: `文章时间 ${articleTime} 晚于任务窗口` }
  }

  const content = article.content ?? ''
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
    // 规则显式提取的摘要优先，否则按正文自动生成
    summary: article.summary?.trim() || buildSummary(content),
    content,
    coverUrl: resolveCoverUrl(article.coverUrl, url),
    articleTime,
    extra: clampJson(metadata),
    // 完整详情一次采出来的文章，详情状态直接记为已采集
    detailStatus: ArticleDetailStatus.COLLECTED,
    ...(input.rawHtml ? { rawHtml: input.rawHtml.slice(0, RAW_HTML_MAX) } : {}),
  }

  const existing = models.article.findOne({ url })

  if (existing) {
    models.article.update(existing.id, fields)
    return { status: 'updated', articleId: existing.id }
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
/* 列表 / 详情分离采集                                                          */
/* -------------------------------------------------------------------------- */

export interface ListArticleOutcome {
  status: 'created' | 'skipped'
  articleId?: number
  reason?: string
}

/**
 * 列表阶段入库：落 title + url，以及列表阶段提取到的统一内置字段
 * （作者 / 摘要 / 正文 / 封面 / 文章时间）与自定义字段。
 *
 * 同一 URL 已存在时跳过（不覆盖已有数据），详情留待 `detailStatus` 驱动补采。
 */
export function saveListArticle(input: {
  siteId: number
  categoryId: number | null
  taskId: number | null
  title: string
  url: string
  coverUrl?: string | null
  author?: string | null
  summary?: string | null
  content?: string | null
  /** 列表阶段提取的文章时间（原始字符串，入库前转 ISO 8601） */
  articleTime?: string | null
  /** 列表阶段提取的自定义字段 */
  extra?: Record<string, unknown>
}): ListArticleOutcome {
  const models = getModels()
  const url = normalizeArticleUrl(input.url)
  if (!url) return { status: 'skipped', reason: '地址为空' }

  const title = input.title.trim()
  if (!title) return { status: 'skipped', reason: '列表标题为空' }

  const existing = models.article.findOne({ url })
  if (existing) {
    // 旧记录缺标题（理论少见）时补齐，其余不覆盖
    if (!existing.title && title) models.article.update(existing.id, { title })
    return { status: 'skipped', articleId: existing.id, reason: '已存在' }
  }

  const created = models.article.create({
    siteId: input.siteId,
    categoryId: input.categoryId,
    taskId: input.taskId,
    title,
    url,
    detailStatus: ArticleDetailStatus.PENDING,
    coverUrl: input.coverUrl ?? null,
    author: input.author ?? null,
    summary: input.summary ?? null,
    content: input.content ?? '',
    articleTime: toIsoTime(input.articleTime),
    extra: clampJson(input.extra ?? {}),
  })
  return { status: 'created', articleId: created.id }
}

export interface DetailArticleOutcome {
  status: 'created' | 'updated'
  articleId?: number
  reason?: string
}

/**
 * 详情补采入库：同名字段**有值才覆盖**列表阶段的值。
 *
 * - URL 不存在（如列表入库前详情先跑）→ 直接按完整文章创建；
 * - 已存在 → 合并字段（空值保留旧值）。
 */
export function applyArticleDetail(input: {
  article: ArticleData
  siteId: number
  categoryId: number | null
  taskId: number | null
  rawHtml?: string | null
}): DetailArticleOutcome {
  const models = getModels()
  const url = normalizeArticleUrl(input.article.url)
  const existing = models.article.findOne({ url })

  if (!existing) {
    const outcome = saveCrawledArticle({
      article: input.article,
      siteId: input.siteId,
      categoryId: input.categoryId,
      taskId: input.taskId,
      rawHtml: input.rawHtml,
    })
    return { status: outcome.status === 'created' ? 'created' : 'updated', articleId: outcome.articleId }
  }

  const merged = mergeDetailFields(existing, input.article)

  models.article.update(existing.id, {
    ...merged,
    detailStatus: ArticleDetailStatus.COLLECTED,
    ...(input.rawHtml ? { rawHtml: input.rawHtml.slice(0, RAW_HTML_MAX) } : {}),
  })
  return { status: 'updated', articleId: existing.id }
}

/**
 * 「有值才覆盖」的字段合并。
 *
 * 详情提取为空（未映射到 / 页面没有）时保留列表阶段已有的值，
 * 避免详情失败把标题、封面等清掉；详情有值才覆盖。
 */
function mergeDetailFields(existing: ArticleRow, article: ArticleData): Record<string, unknown> {
  const pick = (incoming: string | null | undefined, old: string | null | undefined): string | null => {
    const value = incoming?.trim()
    return value ? value : (old ?? null)
  }

  const content = pick(article.content, existing.content)
  const author = pick(article.author, existing.author)

  const articleTime = (() => {
    const incoming = readArticleTime(article)
    return incoming ?? existing.articleTime ?? null
  })()

  const coverUrl = resolveCoverUrl(article.coverUrl, existing.url ?? '') ?? existing.coverUrl ?? null

  const summary = content ? buildSummary(content) : existing.summary ?? null

  // 自定义字段：详情的 extra 与列表阶段的 extra 按键合并，详情有值才覆盖
  const mergedExtra: Record<string, unknown> = { ...parseExtra(existing.extra) }
  if (article.metadata) {
    for (const [key, value] of Object.entries(article.metadata)) {
      if (key === 'sourceUrl' || key === 'listTitle') continue
      if (value !== null && value !== undefined && value !== '') mergedExtra[key] = value
    }
  }

  return {
    title: article.title.trim() || existing.title,
    author,
    summary,
    content: content ?? '',
    coverUrl,
    articleTime,
    extra: clampJson(mergedExtra),
  }
}

/** 标记详情采集失败（可重试）。 */
export function markArticleDetailFailed(rawUrl: string): void {
  const url = normalizeArticleUrl(rawUrl)
  const existing = getModels().article.findOne({ url })
  if (!existing) return
  getModels().article.update(existing.id, {
    detailStatus: ArticleDetailStatus.FAILED,
  })
}

/** 查询待补采详情的文章（pending / failed），按 id 升序分批返回。 */
export function listArticlesForDetailCollect(options: {
  siteId: number
  categoryId?: number | null
  /** 断点内已处理的 URL，跳过 */
  excludeUrls?: ReadonlySet<string>
  limit?: number
}): Array<{ id: number; title: string; url: string }> {
  const db = getDatabaseContext().db
  const conditions = ["t.siteId = ?", "t.detailStatus IN ('pending', 'failed')"]
  const params: Array<string | number> = [options.siteId]
  if (options.categoryId) {
    conditions.push('t.categoryId = ?')
    params.push(options.categoryId)
  }
  const where = conditions.join(' AND ')
  const limit = Math.min(Math.max(1, options.limit ?? 200), 1000)
  const rows = db
    .prepare(`SELECT id, title, url FROM article t WHERE ${where} ORDER BY t.id ASC LIMIT ?`)
    .all(...params, limit * 2) as Array<{ id: number; title: string | null; url: string | null }>

  const exclude = options.excludeUrls
  const result: Array<{ id: number; title: string; url: string }> = []
  for (const row of rows) {
    if (!row.url) continue
    const normalized = normalizeArticleUrl(row.url)
    if (exclude?.has(normalized)) continue
    result.push({ id: row.id, title: row.title ?? '', url: row.url })
    if (result.length >= limit) break
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* 详情补采                                                                    */
/* -------------------------------------------------------------------------- */

/** 待补采文章的最小信息：补采只需要 id、归属与地址。 */
export interface ArticleCollectTarget {
  id: number
  siteId: number
  categoryId: number | null
  title: string
  url: string
}

/**
 * 查询待补采的文章。
 *
 * 只有 `pending` / `failed` 需要补采，`collected` 一律排除。
 * 指定 `ids` 时按 id 过滤（文章页勾选补采），否则按站点 / 栏目 / 关键字筛选。
 */
export function listArticlesForCollect(options: {
  ids?: number[]
  siteId?: number
  categoryId?: number
  keyword?: string
  /** 单次上限，默认 200，最大 500 */
  limit?: number
}): ArticleCollectTarget[] {
  const db = getDatabaseContext().db
  const conditions = ["t.detailStatus IN ('pending', 'failed')", 't.url IS NOT NULL']
  const params: Array<string | number> = []

  if (options.ids?.length) {
    conditions.push(`t.id IN (${options.ids.map(() => '?').join(', ')})`)
    params.push(...options.ids)
  }
  if (options.siteId) {
    conditions.push('t.siteId = ?')
    params.push(options.siteId)
  }
  if (options.categoryId) {
    conditions.push('t.categoryId = ?')
    params.push(options.categoryId)
  }
  if (options.keyword) {
    const pattern = likePattern(options.keyword)
    conditions.push("(t.title LIKE ? ESCAPE '\\' OR t.summary LIKE ? ESCAPE '\\')")
    params.push(pattern, pattern)
  }

  const limit = Math.min(Math.max(1, options.limit ?? 200), 500)
  const rows = db
    .prepare(
      `SELECT t.id, t.siteId, t.categoryId, t.title, t.url
       FROM article t WHERE ${conditions.join(' AND ')} ORDER BY t.id ASC LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number
    siteId: number
    categoryId: number | null
    title: string | null
    url: string | null
  }>

  const result: ArticleCollectTarget[] = []
  for (const row of rows) {
    if (!row.url) continue
    result.push({
      id: row.id,
      siteId: row.siteId,
      categoryId: row.categoryId,
      title: row.title ?? '',
      url: row.url,
    })
  }
  return result
}

/** 按 id 查询待补采文章（详情补采任务使用），仍受站点 / 栏目约束。 */
export function listArticlesForDetailCollectByIds(options: {
  ids: number[]
  siteId: number
  categoryId?: number | null
}): Array<{ id: number; title: string; url: string }> {
  if (options.ids.length === 0) return []
  return listArticlesForCollect({
    ids: options.ids,
    siteId: options.siteId,
    ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    limit: 500,
  }).map(({ id, title, url }) => ({ id, title, url }))
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
  detailStatus: z.enum(['pending', 'collected', 'failed']).optional(),
  articleTimeFrom: isoTimeField.optional(),
  articleTimeTo: isoTimeField.optional(),
  createdFrom: isoTimeField.optional(),
  createdTo: isoTimeField.optional(),
  sort: z.enum(['id', 'articleTime', 'createdAt']).default('id'),
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
  if (query.detailStatus) {
    conditions.push('t.detailStatus = ?')
    params.push(query.detailStatus)
  }
  if (query.keyword) {
    conditions.push(
      "(t.title LIKE ? ESCAPE '\\' OR t.summary LIKE ? ESCAPE '\\' OR t.content LIKE ? ESCAPE '\\')",
    )
    const pattern = likePattern(query.keyword)
    params.push(pattern, pattern, pattern)
  }
  if (query.articleTimeFrom) {
    conditions.push('t.articleTime >= ?')
    params.push(query.articleTimeFrom)
  }
  if (query.articleTimeTo) {
    conditions.push('t.articleTime <= ?')
    params.push(query.articleTimeTo)
  }
  if (query.createdFrom) {
    conditions.push('t.createdAt >= ?')
    params.push(query.createdFrom)
  }
  if (query.createdTo) {
    conditions.push('t.createdAt <= ?')
    params.push(query.createdTo)
  }

  return { conditions, params }
}

/** 列表不返回正文与原始 HTML。 */
const SUMMARY_COLUMNS =
  't.id, t.siteId, t.categoryId, t.taskId, t.title, t.url, t.author, t.summary, t.coverUrl, t.articleTime, t.detailStatus, t.createdAt, t.updatedAt'

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
  | 'articleTime'
  | 'detailStatus'
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
    articleTime: row.articleTime,
    detailStatus: (row.detailStatus ?? 'collected') as ArticleDetailStatus,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

export function listArticles(query: ArticleListQuery) {
  const { conditions, params } = buildWhere(query)
  const sortColumn =
    query.sort === 'articleTime' ? 't.articleTime' : query.sort === 'createdAt' ? 't.createdAt' : 't.id'
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
    ...toSummaryDto({ ...row } as SummaryRow),
    content: row.content,
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
  'coverUrl',
  'articleTime',
  'detailStatus',
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
          `SELECT id, title, url, siteId, categoryId, taskId, author, coverUrl, articleTime, detailStatus, summary, content, extra
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
              row.coverUrl,
              row.articleTime,
              row.detailStatus,
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
          coverUrl: row.coverUrl,
          articleTime: row.articleTime,
          detailStatus: row.detailStatus,
          summary: row.summary,
          content: row.content,
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
