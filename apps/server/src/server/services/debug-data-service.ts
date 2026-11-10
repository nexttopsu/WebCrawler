import { z } from 'zod'
import {
  ensureDebugDatabase,
  getDebugDatabase,
  isDebugDatabaseInitialized,
  lastDebugDatabaseFile,
  type Database,
} from '../../database/index.js'
import type {
  DebugContentType,
  DebugSampleDetailDto,
  DebugSampleDto,
  PaginatedData,
} from '../../shared/index.js'
import { loadConfig } from '../config.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'

/**
 * 调试数据服务。
 *
 * 一张表解决两件事：
 * 1. 管理界面（列表 / 新增 / 编辑 / 批量删除）—— 列表不返回 raw，只给字节数；
 * 2. 采集与测试的「短路」—— 网址完全相等时直接返回存档 raw，不发网络请求。
 *
 * 网址匹配是**严格相等**：不做协议补全、去尾斜杠或参数排序，
 * 否则「我明明存了这条却没命中」会变成难以排查的隐式行为。
 */

/** 单条 raw 上限：20 MB，避免一次写入把库撑爆（也防止前端误贴整个文件）。 */
export const RAW_MAX_BYTES = 20 * 1024 * 1024

const DEBUG_CONTENT_TYPES = ['html', 'json'] as const

/** 列表查询参数。 */
export const debugSampleListQuerySchema = z.object({
  ...paginationFields,
  keyword: keywordField,
  contentType: z.enum(DEBUG_CONTENT_TYPES).optional(),
  enabled: z.enum(['true', 'false']).optional(),
})

export type DebugSampleListQuery = z.infer<typeof debugSampleListQuerySchema>

const urlField = z
  .string()
  .trim()
  .min(1, '网址必填')
  .max(2048, '网址不能超过 2048 个字符')
  .refine((value) => /^https?:\/\//i.test(value), '网址必须是 http(s) 绝对地址')

/** 新增入参。 */
export const debugSampleCreateSchema = z
  .object({
    url: urlField,
    raw: z.string().min(1, 'raw 不能为空').max(RAW_MAX_BYTES, 'raw 超过 20 MB 上限'),
    statusCode: z.number().int().min(100).max(599).default(200),
    contentType: z.enum(DEBUG_CONTENT_TYPES).default('html'),
    note: z.string().trim().max(200).nullish(),
    enabled: z.boolean().default(true),
  })
  .strict()

/** 编辑入参：所有字段可选，但至少要改一项。 */
export const debugSampleUpdateSchema = z
  .object({
    url: urlField.optional(),
    raw: z.string().min(1, 'raw 不能为空').max(RAW_MAX_BYTES, 'raw 超过 20 MB 上限').optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    contentType: z.enum(DEBUG_CONTENT_TYPES).optional(),
    note: z.string().trim().max(200).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: '没有需要修改的字段',
  })

export type DebugSampleCreateInput = z.infer<typeof debugSampleCreateSchema>
export type DebugSampleUpdateInput = z.infer<typeof debugSampleUpdateSchema>

/** 批量删除入参：ids 与筛选条件二选一（也可以同时给，条件取交集）。 */
export const debugSampleDeleteQuerySchema = z
  .object({
    /** 逗号分隔的 id 列表；来自列表勾选 */
    ids: z.string().trim().max(4000).optional(),
    keyword: keywordField,
    contentType: z.enum(DEBUG_CONTENT_TYPES).optional(),
    enabled: z.enum(['true', 'false']).optional(),
  })
  .strict()

export type DebugSampleDeleteQuery = z.infer<typeof debugSampleDeleteQuerySchema>

/* -------------------------------------------------------------------------- */
/* 行 ↔ DTO                                                                    */
/* -------------------------------------------------------------------------- */

interface DebugSampleRow {
  id: number
  url: string | null
  statusCode: number | null
  contentType: string | null
  note: string | null
  enabled: number | null
  rawSize: number | null
  hitCount: number | null
  lastHitAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

interface DebugSampleDetailRow extends DebugSampleRow {
  raw: string | null
}

/** 列表列清单：刻意不含 raw，避免把几百 KB 原文拖进列表接口。 */
const LIST_COLUMNS =
  'id, url, statusCode, contentType, note, enabled, hitCount, lastHitAt, createdAt, updatedAt, length(CAST(raw AS BLOB)) AS rawSize'

function toContentType(value: string | null): DebugContentType {
  return value === 'json' ? 'json' : 'html'
}

function toDto(row: DebugSampleRow): DebugSampleDto {
  return {
    id: row.id,
    url: row.url ?? '',
    statusCode: row.statusCode ?? 200,
    contentType: toContentType(row.contentType),
    note: row.note,
    enabled: (row.enabled ?? 1) === 1,
    rawSize: Number(row.rawSize ?? 0),
    hitCount: Number(row.hitCount ?? 0),
    lastHitAt: row.lastHitAt,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

function toDetailDto(row: DebugSampleDetailRow): DebugSampleDetailDto {
  return { ...toDto(row), raw: row.raw ?? '' }
}

function enabledParam(value: 'true' | 'false' | undefined): number | undefined {
  if (value === undefined) return undefined
  return value === 'true' ? 1 : 0
}

/** 把筛选条件翻译成 WHERE 片段，list 与 batchDelete 共用，保证语义一致。 */
function buildConditions(query: {
  keyword?: string
  contentType?: DebugContentType
  enabled?: 'true' | 'false'
  ids?: string
}): { conditions: string[]; params: Array<string | number> } {
  const conditions: string[] = []
  const params: Array<string | number> = []

  const ids = (query.ids ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
  if (query.ids !== undefined) {
    if (ids.length === 0) {
      throw new ValidationError('ids 必须是逗号分隔的正整数', [
        { path: 'ids', message: '没有可用的 id', code: 'invalid_value' },
      ])
    }
    conditions.push(`id IN (${ids.map(() => '?').join(', ')})`)
    params.push(...ids)
  }

  if (query.keyword) {
    conditions.push("(url LIKE ? ESCAPE '\\' OR IFNULL(note, '') LIKE ? ESCAPE '\\')")
    const pattern = likePattern(query.keyword)
    params.push(pattern, pattern)
  }
  if (query.contentType) {
    conditions.push('contentType = ?')
    params.push(query.contentType)
  }
  const enabled = enabledParam(query.enabled)
  if (enabled !== undefined) {
    conditions.push('enabled = ?')
    params.push(enabled)
  }

  return { conditions, params }
}

/**
 * 取调试库连接，必要时就地创建。
 *
 * 正常启动由 `createApp` 建库；这里兜住两种「运行中库不见了」的情况：
 * 连接被提前关闭（测试 teardown、脚本里 `closeDatabase()`），或运行前把
 * `data/debug.db` 删了。此时按上次用的路径（没有则读配置）重新建库建表，
 * 避免调试数据接口 500、采集命中静默失效。
 */
function db(): Database {
  if (isDebugDatabaseInitialized()) return getDebugDatabase()

  // 优先按上次用过的路径重建：测试注入的 `:memory:` 也能原样复用
  const known = lastDebugDatabaseFile()
  if (known) return ensureDebugDatabase(known).db

  const config = loadConfig()
  // 测试环境不自动落盘：没初始化就用内存库，避免在仓库里留下 data/debug.db
  if (config.env === 'test') return ensureDebugDatabase(':memory:').db
  return ensureDebugDatabase(config.debugDatabaseFile).db
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                        */
/* -------------------------------------------------------------------------- */

/** 分页列表（不含 raw）。 */
export function listDebugSamples(query: DebugSampleListQuery): PaginatedData<DebugSampleDto> {
  const { conditions, params } = buildConditions(query)
  const { rows, total } = runRawList<DebugSampleRow>(db(), {
    select: LIST_COLUMNS,
    from: 'debug_sample',
    conditions,
    params,
    orderBy: 'id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })
  return toPage(rows.map(toDto), total, query.page, query.pageSize)
}

/** 单条详情（含 raw）。 */
export function getDebugSample(id: number): DebugSampleDetailDto {
  const row = db()
    .prepare(`SELECT ${LIST_COLUMNS}, raw FROM debug_sample WHERE id = ?`)
    .get(id) as unknown as DebugSampleDetailRow | undefined
  if (!row) throw new NotFoundError(`调试数据 #${id} 不存在`)
  return toDetailDto(row)
}

/** 按网址查一条（管理界面用；采集侧走 `lookupDebugRaw`）。 */
function findIdByUrl(url: string, excludeId?: number): number | null {
  const row = db()
    .prepare('SELECT id FROM debug_sample WHERE url = ? AND id <> ? ORDER BY id DESC LIMIT 1')
    .get(url, excludeId ?? 0) as unknown as { id: number } | undefined
  return row?.id ?? null
}

/* -------------------------------------------------------------------------- */
/* 写入                                                                        */
/* -------------------------------------------------------------------------- */

/** 新增：网址唯一，重复时返回 409 并指向已有条目。 */
export function createDebugSample(input: DebugSampleCreateInput): DebugSampleDetailDto {
  const url = input.url.trim()
  const existing = findIdByUrl(url)
  if (existing) {
    throw new ConflictError(`该网址已有调试数据（#${existing}），请直接编辑那一条`, [
      { path: 'url', message: '网址重复', code: 'duplicate', id: existing },
    ])
  }

  const now = new Date().toISOString()
  const result = db()
    .prepare(
      `INSERT INTO debug_sample (url, raw, statusCode, contentType, note, enabled, hitCount, lastHitAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .run(
      url,
      input.raw,
      input.statusCode,
      input.contentType,
      input.note ?? null,
      input.enabled ? 1 : 0,
      now,
      now,
    )
  return getDebugSample(Number(result.lastInsertRowid))
}

/** 捕获浏览器写入时使用的一条记录。 */
export interface CapturedSampleInput {
  url: string
  raw: string
  statusCode: number
  contentType: DebugContentType
  /** 备注：仅新建时写入，不覆盖用户已经填过的备注 */
  note?: string | null
}

/**
 * 保存一条「浏览器捕获」的数据。
 *
 * 与手工新增的区别：网址重复时**覆盖 raw 而不是报 409**。
 * 捕获浏览器本来就是「再访问一次同一个页面」，报冲突会让整个功能不可用；
 * 已有条目的备注、启停状态与命中统计都保留，只更新原文、状态码与类型。
 */
export function saveCapturedSample(input: CapturedSampleInput): {
  id: number
  created: boolean
  rawSize: number
} {
  const url = input.url.trim()
  if (!url) throw new ValidationError('网址不能为空')

  const database = db()
  const existing = database
    .prepare('SELECT id FROM debug_sample WHERE url = ? ORDER BY id DESC LIMIT 1')
    .get(url) as unknown as { id: number } | undefined
  const now = new Date().toISOString()
  const rawSize = Buffer.byteLength(input.raw, 'utf8')

  if (existing) {
    database
      .prepare(
        `UPDATE debug_sample
            SET raw = ?, statusCode = ?, contentType = ?, note = COALESCE(note, ?), updatedAt = ?
          WHERE id = ?`,
      )
      .run(
        input.raw,
        input.statusCode,
        input.contentType,
        input.note ?? null,
        now,
        existing.id,
      )
    return { id: existing.id, created: false, rawSize }
  }

  const result = database
    .prepare(
      `INSERT INTO debug_sample (url, raw, statusCode, contentType, note, enabled, hitCount, lastHitAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
    )
    .run(url, input.raw, input.statusCode, input.contentType, input.note ?? null, now, now)
  return { id: Number(result.lastInsertRowid), created: true, rawSize }
}

/** 编辑：网址改动时同样要求唯一。 */
export function updateDebugSample(id: number, input: DebugSampleUpdateInput): DebugSampleDetailDto {
  const current = getDebugSample(id)
  const url = input.url === undefined ? current.url : input.url.trim()

  if (url !== current.url) {
    const existing = findIdByUrl(url, id)
    if (existing) {
      throw new ConflictError(`该网址已有调试数据（#${existing}），请直接编辑那一条`, [
        { path: 'url', message: '网址重复', code: 'duplicate', id: existing },
      ])
    }
  }

  const fields: string[] = []
  const values: Array<string | number | null> = []
  const push = (column: string, value: string | number | null): void => {
    fields.push(`${column} = ?`)
    values.push(value)
  }

  push('url', url)
  if (input.raw !== undefined) push('raw', input.raw)
  if (input.statusCode !== undefined) push('statusCode', input.statusCode)
  if (input.contentType !== undefined) push('contentType', input.contentType)
  if (input.note !== undefined) push('note', input.note ?? null)
  if (input.enabled !== undefined) push('enabled', input.enabled ? 1 : 0)
  push('updatedAt', new Date().toISOString())

  db()
    .prepare(`UPDATE debug_sample SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values, id)
  return getDebugSample(id)
}

/** 删除单条。 */
export function deleteDebugSample(id: number): { deleted: number } {
  getDebugSample(id)
  const result = db().prepare('DELETE FROM debug_sample WHERE id = ?').run(id)
  return { deleted: Number(result.changes ?? 0) }
}

/**
 * 按条件批量删除（勾选的 ids 或当前筛选条件）。
 *
 * 和日志中心一致：必须给出范围，不允许无条件的「清空全部」，
 * 避免一次误点把整库调试数据删掉。
 */
export function deleteDebugSamples(query: DebugSampleDeleteQuery): { deleted: number } {
  const { conditions, params } = buildConditions(query)
  if (conditions.length === 0) {
    throw new ValidationError('请至少设置一个删除条件（勾选记录或筛选条件）', [
      { path: 'query', message: '至少需要一个筛选条件', code: 'too_few' },
    ])
  }
  const result = db()
    .prepare(`DELETE FROM debug_sample WHERE ${conditions.join(' AND ')}`)
    .run(...params)
  return { deleted: Number(result.changes ?? 0) }
}

/* -------------------------------------------------------------------------- */
/* 采集侧命中                                                                  */
/* -------------------------------------------------------------------------- */

/** 命中调试数据时返回给引擎的「假响应」。 */
export interface DebugRawHit {
  raw: string
  statusCode: number
  contentType: DebugContentType
}

/**
 * 只判断「这个网址有没有可用的调试数据」，不累加命中次数。
 *
 * 测试器用它提前决定「不需要启动浏览器」，真正的取数仍然走 `lookupDebugRaw`，
 * 这样命中次数的统计口径只有一处，不会被预检放大。
 */
export function hasDebugRaw(url: string): boolean {
  const key = url.trim()
  if (!key) return false
  try {
    const row = db()
      .prepare('SELECT 1 AS hit FROM debug_sample WHERE url = ? AND enabled = 1 LIMIT 1')
      .get(key)
    return Boolean(row)
  } catch {
    return false
  }
}

/**
 * 按网址精确查找可用的调试数据。
 *
 * 供采集引擎在发请求前调用，约定：
 * - 网址 **完全相等** 才算命中（只去掉首尾空白）；
 * - 只匹配 `enabled = 1` 的条目，停用的数据保留但不参与；
 * - 任何异常都返回 null —— 调试库坏了不能拖垮采集主流程；
 * - 命中后累加命中次数，供界面判断这条数据是否还在被使用。
 */
export function lookupDebugRaw(url: string): DebugRawHit | null {
  const key = url.trim()
  if (!key) return null

  try {
    const database = db()
    const row = database
      .prepare(
        'SELECT id, raw, statusCode, contentType FROM debug_sample WHERE url = ? AND enabled = 1 ORDER BY id DESC LIMIT 1',
      )
      .get(key) as unknown as
      | { id: number; raw: string | null; statusCode: number | null; contentType: string | null }
      | undefined
    if (!row) return null

    try {
      database
        .prepare('UPDATE debug_sample SET hitCount = hitCount + 1, lastHitAt = ? WHERE id = ?')
        .run(new Date().toISOString(), row.id)
    } catch {
      // 统计失败不影响返回数据
    }

    return {
      raw: row.raw ?? '',
      statusCode: row.statusCode ?? 200,
      contentType: toContentType(row.contentType),
    }
  } catch {
    return null
  }
}
