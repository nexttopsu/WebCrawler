import type { Database } from '@webcrawler/database'
import { z } from 'zod'
import type { PaginatedData } from '@webcrawler/shared'

/** 默认每页条数。 */
export const PAGE_SIZE_DEFAULT = 20

/** 每页条数上限：防止一次请求拉全表。 */
export const PAGE_SIZE_MAX = 100

/**
 * 分页参数。
 *
 * 用 `z.coerce` 把查询字符串转成数字；上限在 Schema 里收敛，
 * 超出范围的 `pageSize` 直接 400，而不是静默截断成 100——
 * 静默截断会让前端误以为拿到了全部数据。
 */
export const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
}

/** 关键词参数：去掉首尾空白，限制长度，避免把超长串丢给 LIKE。 */
export const keywordField = z.string().trim().min(1).max(100).optional()

/** 构造统一的分页载荷。空结果时总页数记为 1，前端无需特殊处理。 */
export function toPage<T>(items: T[], total: number, page: number, pageSize: number): PaginatedData<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** 把关键词转成 LIKE 模式，转义 `%`、`_` 与反斜杠本身。 */
export function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

export interface RawListOptions {
  /** 列清单，必须是代码中的常量 */
  select: string
  /** 表名，必须是代码中的常量 */
  from: string
  /** WHERE 片段（不含 WHERE 关键字），参数用 `?` 占位 */
  conditions: readonly string[]
  /** 与 conditions 顺序对应的参数 */
  params: readonly (string | number | null)[]
  /** 排序子句，必须是代码中的常量 */
  orderBy: string
  page: number
  pageSize: number
}

/**
 * 执行一次分页查询。
 *
 * 关键词搜索需要「关键字 OR + 等值过滤」组合，ORMlet 的 `search()` 不支持附加 where，
 * 因此列表查询统一走这里的原生 SQL。表名、列名、排序都来自代码常量，
 * 只有值通过参数绑定传入，不存在拼接用户输入的情况。
 */
export function runRawList<T>(db: Database, options: RawListOptions): { rows: T[]; total: number } {
  const where = options.conditions.length > 0 ? options.conditions.join(' AND ') : '1 = 1'
  const offset = (options.page - 1) * options.pageSize

  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM ${options.from} WHERE ${where}`)
    .get(...options.params) as unknown as { total: number } | undefined
  const total = Number(countRow?.total ?? 0)

  const rows = db
    .prepare(
      `SELECT ${options.select} FROM ${options.from} WHERE ${where} ORDER BY ${options.orderBy} LIMIT ? OFFSET ?`,
    )
    .all(...options.params, options.pageSize, offset) as unknown as T[]

  return { rows, total }
}
