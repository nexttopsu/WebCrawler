/**
 * 仪表盘统计。
 *
 * 全部走聚合查询，没有数据就返回 0 / 空数组——绝不编造示例数字。
 * 日期分桶使用 SQLite 的 `localtime` 修饰符，保证「今天」与用户看到的一致。
 */
import { getDatabaseContext, getModels } from '@webcrawler/database'
import { CrawlTaskStatus } from '@webcrawler/shared'
import type { ProxyOverviewDto, StatsOverviewDto, StatsTrendPoint } from '@webcrawler/shared'
import { listLogs } from './log-service.js'
import { listTasks } from './task-service.js'

interface CountRow {
  day: string | null
  count: number
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 最近 `days` 天的日期键（含今天，按时间升序）。 */
function recentDays(days: number): string[] {
  const keys: string[] = []
  const today = new Date()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    keys.push(localDateKey(date))
  }
  return keys
}

function scalar(sql: string, ...params: Array<string | number>): number {
  const row = getDatabaseContext().db.prepare(sql).get(...params) as { value: number | null } | undefined
  return Number(row?.value ?? 0)
}

function groupByDay(sql: string, ...params: Array<string | number>): Map<string, number> {
  const rows = getDatabaseContext().db.prepare(sql).all(...params) as unknown as CountRow[]
  const map = new Map<string, number>()
  for (const row of rows) {
    if (!row.day) continue
    map.set(row.day, Number(row.count ?? 0))
  }
  return map
}

function proxyOverview(): ProxyOverviewDto {
  const rows = getDatabaseContext().db
    .prepare('SELECT status, enabled, COUNT(*) AS count FROM proxy GROUP BY status, enabled')
    .all() as unknown as Array<{ status: string | null; enabled: number | null; count: number }>

  const result: ProxyOverviewDto = { total: 0, enabled: 0, available: 0, unavailable: 0, unchecked: 0 }
  for (const row of rows) {
    const count = Number(row.count ?? 0)
    result.total += count
    if (row.enabled === 1) result.enabled += count
    if (row.status === 'available') result.available += count
    else if (row.status === 'unavailable') result.unavailable += count
    else if (row.status === 'unknown' || !row.status) result.unchecked += count
  }
  return result
}

/** 任务成功率：近 30 天 completed / (completed + failed)，无样本返回 null。 */
function successRate(): number | null {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const rows = getDatabaseContext().db
    .prepare(
      "SELECT status, COUNT(*) AS count FROM crawl_task WHERE status IN ('completed','failed') AND createdAt >= ? GROUP BY status",
    )
    .all(since) as unknown as Array<{ status: string | null; count: number }>

  let completed = 0
  let failed = 0
  for (const row of rows) {
    if (row.status === 'completed') completed += Number(row.count ?? 0)
    else if (row.status === 'failed') failed += Number(row.count ?? 0)
  }
  const total = completed + failed
  if (total === 0) return null
  return Math.round((completed / total) * 1000) / 1000
}

export function buildOverview(days = 14): StatsOverviewDto {
  const window = Math.min(Math.max(1, days), 90)
  const keys = recentDays(window)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (window - 1))
  const sinceIso = start.toISOString()

  const articleByDay = groupByDay(
    "SELECT date(crawlTime, 'localtime') AS day, COUNT(*) AS count FROM article WHERE crawlTime IS NOT NULL AND crawlTime >= ? GROUP BY day",
    sinceIso,
  )
  const completedByDay = groupByDay(
    "SELECT date(completedAt, 'localtime') AS day, COUNT(*) AS count FROM crawl_task WHERE status = 'completed' AND completedAt IS NOT NULL AND completedAt >= ? GROUP BY day",
    sinceIso,
  )
  const failedByDay = groupByDay(
    "SELECT date(completedAt, 'localtime') AS day, COUNT(*) AS count FROM crawl_task WHERE status = 'failed' AND completedAt IS NOT NULL AND completedAt >= ? GROUP BY day",
    sinceIso,
  )

  const trend: StatsTrendPoint[] = keys.map((date) => ({
    date,
    articles: articleByDay.get(date) ?? 0,
    completedTasks: completedByDay.get(date) ?? 0,
    failedTasks: failedByDay.get(date) ?? 0,
  }))

  const tasks = listTasks({ page: 1, pageSize: 6 })
  const errors = listLogs({ page: 1, pageSize: 8, level: 'error' })

  return {
    generatedAt: new Date().toISOString(),
    days: window,
    counts: {
      sites: getModels().site.count(),
      categories: getModels().category.count(),
      articles: getModels().article.count(),
      tasks: getModels().crawlTask.count(),
      proxies: getModels().proxy.count(),
      plugins: getModels().plugin.count(),
    },
    today: {
      articles: scalar(
        "SELECT COUNT(*) AS value FROM article WHERE crawlTime IS NOT NULL AND date(crawlTime, 'localtime') = date('now', 'localtime')",
      ),
      tasks: scalar(
        "SELECT COUNT(*) AS value FROM crawl_task WHERE date(createdAt, 'localtime') = date('now', 'localtime')",
      ),
    },
    running: {
      tasks: getModels().crawlTask.count({ status: CrawlTaskStatus.RUNNING }),
      pending: getModels().crawlTask.count({ status: CrawlTaskStatus.PENDING }),
    },
    successRate: successRate(),
    trend,
    recentTasks: tasks.items,
    recentErrors: errors.items,
    proxies: proxyOverview(),
  }
}
