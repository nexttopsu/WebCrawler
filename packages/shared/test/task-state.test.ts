import { describe, expect, it } from 'vitest'
import { CrawlTaskStatus } from '../src/domain.js'
import {
  canTransition,
  describeInvalidTransition,
  isTerminalTaskStatus,
} from '../src/task-state.js'

describe('任务状态机', () => {
  it('允许排队、运行、暂停、完成之间的正常流转', () => {
    expect(canTransition(CrawlTaskStatus.PENDING, CrawlTaskStatus.RUNNING)).toBe(true)
    expect(canTransition(CrawlTaskStatus.RUNNING, CrawlTaskStatus.PAUSED)).toBe(true)
    expect(canTransition(CrawlTaskStatus.PAUSED, CrawlTaskStatus.PENDING)).toBe(true)
    expect(canTransition(CrawlTaskStatus.RUNNING, CrawlTaskStatus.COMPLETED)).toBe(true)
    expect(canTransition(CrawlTaskStatus.RUNNING, CrawlTaskStatus.FAILED)).toBe(true)
    expect(canTransition(CrawlTaskStatus.RUNNING, CrawlTaskStatus.CANCELLED)).toBe(true)
  })

  it('已完成的任务不能再被暂停或重跑', () => {
    expect(canTransition(CrawlTaskStatus.COMPLETED, CrawlTaskStatus.RUNNING)).toBe(false)
    expect(canTransition(CrawlTaskStatus.COMPLETED, CrawlTaskStatus.PAUSED)).toBe(false)
    expect(canTransition(CrawlTaskStatus.COMPLETED, CrawlTaskStatus.CANCELLED)).toBe(false)
  })

  it('失败 / 取消后只能通过 pending 重试', () => {
    expect(canTransition(CrawlTaskStatus.FAILED, CrawlTaskStatus.PENDING)).toBe(true)
    expect(canTransition(CrawlTaskStatus.CANCELLED, CrawlTaskStatus.PENDING)).toBe(true)
    expect(canTransition(CrawlTaskStatus.FAILED, CrawlTaskStatus.RUNNING)).toBe(false)
    expect(canTransition(CrawlTaskStatus.CANCELLED, CrawlTaskStatus.COMPLETED)).toBe(false)
  })

  it('终态判定', () => {
    expect(isTerminalTaskStatus(CrawlTaskStatus.COMPLETED)).toBe(true)
    expect(isTerminalTaskStatus(CrawlTaskStatus.FAILED)).toBe(true)
    expect(isTerminalTaskStatus(CrawlTaskStatus.CANCELLED)).toBe(true)
    expect(isTerminalTaskStatus(CrawlTaskStatus.PENDING)).toBe(false)
    expect(isTerminalTaskStatus(CrawlTaskStatus.PAUSED)).toBe(false)
  })

  it('拒绝转换时给出可读原因与允许的目标', () => {
    const message = describeInvalidTransition(CrawlTaskStatus.COMPLETED, CrawlTaskStatus.RUNNING)
    expect(message).toContain('不能从 completed 变为 running')
    expect(message).toContain('终态')
    expect(describeInvalidTransition(CrawlTaskStatus.PENDING, CrawlTaskStatus.RUNNING)).toBeNull()
  })
})
