/**
 * 仪表盘统计的对外结构。
 *
 * 所有字段都来自真实聚合查询：没有数据时返回 0 或空数组，
 * 不使用任何示例数据填充，前端据此展示空状态。
 */
import type { LogEntryDto } from './log.js'
import type { TaskDto } from './task.js'

/** 单日趋势点。`date` 为本地时区的 `YYYY-MM-DD`。 */
export interface StatsTrendPoint {
  date: string
  /** 当日入库文章数 */
  articles: number
  /** 当日完成的任务数 */
  completedTasks: number
  /** 当日失败的任务数 */
  failedTasks: number
}

/** 代理状态概览。 */
export interface ProxyOverviewDto {
  total: number
  enabled: number
  available: number
  unavailable: number
  unchecked: number
}

/** 仪表盘总览。 */
export interface StatsOverviewDto {
  generatedAt: string
  /** 时间窗口（天），趋势数组长度与之相同 */
  days: number
  counts: {
    sites: number
    categories: number
    articles: number
    tasks: number
    proxies: number
    plugins: number
  }
  today: {
    articles: number
    tasks: number
  }
  running: {
    tasks: number
    pending: number
  }
  /** 近 30 天 completed / (completed + failed)；无样本时为 null */
  successRate: number | null
  trend: StatsTrendPoint[]
  recentTasks: TaskDto[]
  recentErrors: LogEntryDto[]
  proxies: ProxyOverviewDto
}
