/**
 * 采集任务状态机。
 *
 * 状态与合法转换集中在这里，服务层、API 与执行器共用同一份判定，
 * 避免「API 允许暂停、执行器却不认」这类漂移。
 *
 * 终态（completed / failed / cancelled）不能直接互相跳转，
 * 重新执行必须经过 `pending`（由「重试」接口完成），
 * 这样每次执行都会重新走排队与并发限制。
 */
import { CrawlTaskStatus } from './domain.js'

/** 允许的状态转换表。 */
export const TASK_TRANSITIONS: Record<CrawlTaskStatus, readonly CrawlTaskStatus[]> = {
  // 排队中的任务也可以暂停：暂停后不再被调度，恢复时重新排队
  [CrawlTaskStatus.PENDING]: [
    CrawlTaskStatus.RUNNING,
    CrawlTaskStatus.PAUSED,
    CrawlTaskStatus.CANCELLED,
  ],
  [CrawlTaskStatus.RUNNING]: [
    CrawlTaskStatus.PAUSED,
    CrawlTaskStatus.COMPLETED,
    CrawlTaskStatus.FAILED,
    CrawlTaskStatus.CANCELLED,
  ],
  // 恢复统一回到 pending 重新排队（执行器按断点续跑）；
  // paused → running 保留给「已在执行、仅短暂挂起」的场景
  [CrawlTaskStatus.PAUSED]: [
    CrawlTaskStatus.PENDING,
    CrawlTaskStatus.RUNNING,
    CrawlTaskStatus.FAILED,
    CrawlTaskStatus.CANCELLED,
  ],
  [CrawlTaskStatus.COMPLETED]: [],
  [CrawlTaskStatus.FAILED]: [CrawlTaskStatus.PENDING],
  [CrawlTaskStatus.CANCELLED]: [CrawlTaskStatus.PENDING],
}

/** 终态集合：这些状态不会再有后台执行。 */
export const TERMINAL_TASK_STATUSES: readonly CrawlTaskStatus[] = [
  CrawlTaskStatus.COMPLETED,
  CrawlTaskStatus.FAILED,
  CrawlTaskStatus.CANCELLED,
]

/** 判断一次状态转换是否合法。 */
export function canTransition(from: CrawlTaskStatus, to: CrawlTaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false
}

/** 是否终态。 */
export function isTerminalTaskStatus(status: CrawlTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

/**
 * 描述被拒绝的转换，供 API 直接放进 409 的 message。
 * 返回 `null` 表示转换合法。
 */
export function describeInvalidTransition(
  from: CrawlTaskStatus,
  to: CrawlTaskStatus,
): string | null {
  if (canTransition(from, to)) return null
  const allowed = TASK_TRANSITIONS[from] ?? []
  const suffix =
    allowed.length > 0 ? `允许的目标状态：${allowed.join('、')}` : '该状态为终态，只能通过重试重新排队'
  return `任务状态不能从 ${from} 变为 ${to}；${suffix}`
}
