/**
 * cron 表达式工具。
 *
 * 用 croner 做语法校验与「下次执行时间」计算：不自己解析 cron，
 * 避免与调度库的语义（特别是时区与 DST）出现偏差。
 */
import { Cron } from 'croner'

/** 校验 5 段 cron 表达式。 */
export function isValidCron(expression: string): boolean {
  try {
    const job = new Cron(expression, { paused: true })
    job.stop()
    return true
  } catch {
    return false
  }
}

/** 计算下次执行时间；表达式非法或已无后续执行时返回 null。 */
export function nextRunAt(expression: string, timezone: string, from: Date = new Date()): string | null {
  try {
    const job = new Cron(expression, { paused: true, timezone })
    const next = job.nextRun(from)
    job.stop()
    return next ? next.toISOString() : null
  } catch {
    return null
  }
}

/** 默认时区：显式 TZ 环境变量优先，否则用系统时区。 */
export function defaultTimeZone(): string {
  return process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
