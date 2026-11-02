import { getDatabaseContext, getModels, type CrawlLogRow } from '@webcrawler/database'
import type { LogEntryDto, LogLevel } from '@webcrawler/shared'
import type { Database } from '@webcrawler/database'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import { redactText, redactUrl, redactValue } from '../lib/redact.js'
import { z } from 'zod'

/** 单条日志的写入参数。 */
export interface LogInput {
  taskId?: number | null
  siteId?: number | null
  categoryId?: number | null
  url?: string | null
  level: LogLevel
  stage: string
  message: string
  detail?: unknown
}

const MESSAGE_MAX = 2000
const DETAIL_MAX = 4000

export const logListQuerySchema = z.object({
  ...paginationFields,
  taskId: z.coerce.number().int().positive().optional(),
  siteId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  stage: z.string().trim().max(32).optional(),
  keyword: keywordField,
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

export type LogListQuery = z.infer<typeof logListQuerySchema>

/**
 * 写入一条任务日志。
 *
 * 任何异常都被吞掉：日志失败不能影响采集主流程，
 * 也不能让「写日志」成为任务失败的原因。写入前统一脱敏。
 */
export function writeLog(input: LogInput): void {
  try {
    const detail =
      input.detail === undefined
        ? null
        : JSON.stringify(redactValue(input.detail)).slice(0, DETAIL_MAX)
    getModels().crawlLog.create({
      taskId: input.taskId ?? null,
      siteId: input.siteId ?? null,
      categoryId: input.categoryId ?? null,
      url: redactUrl(input.url ?? null),
      level: input.level,
      stage: input.stage,
      message: redactText(input.message).slice(0, MESSAGE_MAX),
      detail,
    })
  } catch {
    // 日志表不可用（例如数据库已关闭）时静默跳过
  }
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function toLogDto(row: CrawlLogRow): LogEntryDto {
  return {
    id: row.id,
    taskId: row.taskId,
    siteId: row.siteId,
    categoryId: row.categoryId,
    url: row.url,
    level: (row.level ?? 'info') as LogLevel,
    stage: row.stage ?? 'task',
    message: row.message ?? '',
    detail: parseDetail(row.detail),
    createdAt: row.createdAt ?? '',
  }
}

const LOG_COLUMNS = 'id, taskId, siteId, categoryId, url, level, stage, message, detail, createdAt'

/** 分页查询日志。 */
export function listLogs(query: LogListQuery, db?: Database) {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.taskId) {
    conditions.push('taskId = ?')
    params.push(query.taskId)
  }
  if (query.siteId) {
    conditions.push('siteId = ?')
    params.push(query.siteId)
  }
  if (query.categoryId) {
    conditions.push('categoryId = ?')
    params.push(query.categoryId)
  }
  if (query.level) {
    conditions.push('level = ?')
    params.push(query.level)
  }
  if (query.stage) {
    conditions.push('stage = ?')
    params.push(query.stage)
  }
  if (query.keyword) {
    conditions.push("(message LIKE ? ESCAPE '\\')")
    params.push(likePattern(query.keyword))
  }
  if (query.from) {
    conditions.push('createdAt >= ?')
    params.push(query.from)
  }
  if (query.to) {
    conditions.push('createdAt <= ?')
    params.push(query.to)
  }

  const database = db ?? getDatabaseContext().db

  const { rows, total } = runRawList<CrawlLogRow>(database, {
    select: LOG_COLUMNS,
    from: 'crawl_log',
    conditions,
    params,
    orderBy: 'id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toLogDto), total, query.page, query.pageSize)
}

/** 按任务统计日志条数，供任务详情展示。 */
export function countTaskLogs(taskId: number): number {
  return getModels().crawlLog.count({ taskId })
}

/**
 * 清理超过保留期的任务日志。
 *
 * `retentionDays <= 0` 表示永久保留（返回 0）；
 * 返回实际删除的条数，供设置接口回显。
 */
export function pruneCrawlLogs(retentionDays: number): number {
  if (retentionDays <= 0) return 0
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const db = getDatabaseContext().db
  try {
    const result = db.prepare('DELETE FROM crawl_log WHERE createdAt < ?').run(cutoff)
    return Number(result.changes ?? 0)
  } catch {
    return 0
  }
}
