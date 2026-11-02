import type { CrawlTaskType } from './domain.js'
import type { TaskOptions } from './task.js'

/**
 * 定时采集配置。
 *
 * 调度器只负责「到期创建 CrawlTask」，不在定时回调里执行采集：
 * 采集仍由后台任务执行器按队列与并发规则运行。
 */

/** 调度频率。`cron` 表示用户直接给出表达式。 */
export const ScheduleFrequency = {
  HOURLY: 'hourly',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  CRON: 'cron',
} as const
export type ScheduleFrequency = (typeof ScheduleFrequency)[keyof typeof ScheduleFrequency]

/** 星期取值与 cron 的 0-6 一致（0 = 周日）。 */
export const SCHEDULE_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

/** 定时任务。 */
export interface ScheduleDto {
  id: number
  name: string
  siteId: number
  siteName: string | null
  categoryIds: number[]
  taskType: CrawlTaskType
  frequency: ScheduleFrequency
  /** 实际生效的 cron 表达式（由频率与时间字段生成，或用户直接给出） */
  cron: string
  timezone: string
  enabled: boolean
  options: TaskOptions
  lastRunAt: string | null
  nextRunAt: string | null
  lastTaskId: number | null
  description: string | null
  createdAt: string
  updatedAt: string
}

/** 生成 cron 表达式的输入。 */
export interface CronExpressionInput {
  frequency: ScheduleFrequency
  /** 小时，0-23；hourly 忽略 */
  hour?: number
  /** 分钟，0-59；缺省 0 */
  minute?: number
  /** 星期，0-6；weekly 必填 */
  weekday?: number
  /** 自定义表达式，仅 frequency=cron 使用 */
  cron?: string
}

/**
 * 把「每小时 / 每天 / 每周 / 自定义」转换成 5 段 cron 表达式。
 *
 * 返回 `null` 表示输入不完整（例如 weekly 缺少 weekday），由调用方报 400。
 */
export function buildCronExpression(input: CronExpressionInput): string | null {
  const minute = input.minute ?? 0
  switch (input.frequency) {
    case ScheduleFrequency.HOURLY:
      return `${minute} * * * *`
    case ScheduleFrequency.DAILY:
      return input.hour === undefined ? null : `${minute} ${input.hour} * * *`
    case ScheduleFrequency.WEEKLY:
      return input.hour === undefined || input.weekday === undefined
        ? null
        : `${minute} ${input.hour} * * ${input.weekday}`
    case ScheduleFrequency.CRON:
      return input.cron?.trim() || null
    default:
      return null
  }
}

/** 校验 IANA 时区名。非法时区会让 croner 抛错，这里提前给出可读的 400。 */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}
