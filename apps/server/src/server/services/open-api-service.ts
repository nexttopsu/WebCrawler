import { z } from 'zod'
import { getDatabaseContext } from '../../database/index.js'
import type {
  OpenArticleDetailDto,
  OpenArticleSummaryDto,
  OpenCategoryDto,
  OpenSiteWithColumnsDto,
} from '../../shared/index.js'
import { NotFoundError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawAll, runRawList, toPage } from '../lib/query.js'

/**
 * 开放（只读）接口的查询服务。
 *
 * 与文章管理共用同一批表，但只 `SELECT` 对外字段：任务 id、详情状态、原始 HTML
 * 都不出现在返回结果里，避免以后管理端加字段时顺带泄露出去。
 * `extra`（自定义扩展字段）只在文章详情返回——列表带不上也没必要带。
 * 查询仍走 `runRawList` / `runRawAll`：表名 / 列名 / 排序是代码常量，
 * 用户输入只作为参数绑定值。
 *
 * 网站（含栏目）是配置类数据（数量在几十到几百量级），一次性全量返回；
 * 文章是唯一会持续增长的表，必须分页。
 */

/* -------------------------------------------------------------------------- */
/* 网站（含栏目）                                                               */
/* -------------------------------------------------------------------------- */

const SITE_COLUMNS = 'id, name, createdAt'

type SiteRow = { id: number; name: string | null; createdAt: string | null }

const CATEGORY_COLUMNS = 'id, name, parentId, sortOrder, code, siteId, createdAt'

type CategoryRow = {
  id: number
  name: string | null
  parentId: number | null
  sortOrder: number | null
  code: string | null
  siteId: number | null
  createdAt: string | null
}

function toCategoryDto(row: CategoryRow): OpenCategoryDto {
  return {
    id: row.id,
    name: row.name ?? '',
    parentId: row.parentId ?? null,
    sortOrder: row.sortOrder ?? 0,
    code: row.code,
    siteId: row.siteId ?? 0,
    createdAt: row.createdAt ?? '',
  }
}

/**
 * 网站列表，每个网站带上它的全部栏目。
 *
 * 两条 SQL（站点、栏目）在内存里做一次分组，而不是每个站点查一次栏目：
 * 站点数量小但每次请求都 N+1 查询会明显拖慢首屏，尤其在第三方并发拉取时。
 */
export function listOpenSitesWithColumns(): OpenSiteWithColumnsDto[] {
  const db = getDatabaseContext().db

  const sites = runRawAll<SiteRow>(db, {
    select: SITE_COLUMNS,
    from: 'site',
    conditions: [],
    params: [],
    orderBy: 'id ASC',
  })

  const categories = runRawAll<CategoryRow>(db, {
    select: CATEGORY_COLUMNS,
    from: 'category',
    conditions: [],
    params: [],
    orderBy: 'sortOrder ASC, id ASC',
  })

  const grouped = new Map<number, OpenCategoryDto[]>()
  for (const row of categories) {
    const siteId = row.siteId ?? 0
    const list = grouped.get(siteId)
    if (list) list.push(toCategoryDto(row))
    else grouped.set(siteId, [toCategoryDto(row)])
  }

  return sites.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    createdAt: row.createdAt ?? '',
    columns: grouped.get(row.id) ?? [],
  }))
}

/* -------------------------------------------------------------------------- */
/* 文章                                                                        */
/* -------------------------------------------------------------------------- */

export const openArticleQuerySchema = z.object({
  ...paginationFields,
  siteId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  /** 标题关键词 */
  keyword: keywordField,
  /** 文章时间排序：默认倒序 */
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type OpenArticleQuery = z.infer<typeof openArticleQuerySchema>

/**
 * 文章与站点 / 栏目做 LEFT JOIN，一次取回「归属」名称。
 *
 * 用 LEFT JOIN 而不是内连接：栏目被删或历史文章没有栏目时，文章本身仍要能取到。
 */
const ARTICLE_SELECT = `t.id, t.title, t.siteId, s.name AS siteName,
  t.categoryId, c.name AS categoryName,
  t.author, t.articleTime, t.url, t.summary, t.coverUrl`

const ARTICLE_FROM = `article t
  LEFT JOIN site s ON s.id = t.siteId
  LEFT JOIN category c ON c.id = t.categoryId`

type ArticleRow = {
  id: number
  title: string | null
  siteId: number | null
  siteName: string | null
  categoryId: number | null
  categoryName: string | null
  author: string | null
  articleTime: string | null
  url: string | null
  summary: string | null
  coverUrl: string | null
}

type ArticleDetailRow = ArticleRow & { content: string | null; extra: string | null }

/** 摘要对外截断长度（按字符计）。 */
const SUMMARY_MAX = 300

/**
 * 摘要转纯文本。
 *
 * 采集到的「摘要」可能直接是列表页的一段 HTML（不同站点的规则不一样），
 * 对第三方展示很不友好。对外接口统一去标签、解常见实体、压缩空白并截断，
 * 只在这一层做，不改库里的原始值。
 */
export function toPlainSummary(value: string | null): string | null {
  if (!value) return null

  let text = value
  if (/<[a-z!/][^>]*>/i.test(text)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  }

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    // &amp; 必须最后处理，否则 "&amp;lt;" 会被二次解码成 "<"
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return null
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text
}

function toArticleDto(row: ArticleRow): OpenArticleSummaryDto {
  return {
    id: row.id,
    title: row.title ?? '',
    siteId: row.siteId ?? 0,
    siteName: row.siteName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    author: row.author,
    articleTime: row.articleTime,
    url: row.url ?? '',
    summary: toPlainSummary(row.summary),
    coverUrl: row.coverUrl,
  }
}

export function listOpenArticles(query: OpenArticleQuery) {
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
  if (query.keyword) {
    conditions.push("t.title LIKE ? ESCAPE '\\'")
    params.push(likePattern(query.keyword))
  }

  const direction = query.order === 'asc' ? 'ASC' : 'DESC'
  // 缺少文章时间的记录（列表阶段还没补采到时间）统一排到最后：
  // SQLite 里 NULL 会被当成最小值，正序时反而跑到第一页。
  const orderBy = `(t.articleTime IS NULL) ASC, t.articleTime ${direction}, t.id ${direction}`

  const { rows, total } = runRawList<ArticleRow>(getDatabaseContext().db, {
    select: ARTICLE_SELECT,
    from: ARTICLE_FROM,
    conditions,
    params,
    orderBy,
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toArticleDto), total, query.page, query.pageSize)
}

/** 文章详情：多取正文与扩展字段，其余字段与列表一致。 */
export function getOpenArticle(id: number): OpenArticleDetailDto {
  const row = getDatabaseContext()
    .db.prepare(`SELECT ${ARTICLE_SELECT}, t.content, t.extra FROM ${ARTICLE_FROM} WHERE t.id = ?`)
    .get(id) as unknown as ArticleDetailRow | undefined

  if (!row) throw new NotFoundError(`文章 ${id} 不存在`)

  return { ...toArticleDto(row), content: row.content ?? '', extra: parseExtra(row.extra) }
}

/** 解析 extra JSON；坏数据一律退回空对象，不把异常抛给对接方。 */
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
