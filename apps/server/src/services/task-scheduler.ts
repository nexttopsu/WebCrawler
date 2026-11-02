import { getModels } from '@webcrawler/database'
import { Cron } from 'croner'
import type { Logger } from '../lib/logger.js'
import { writeLog } from './log-service.js'
import { getScheduleRow, refreshNextRun, runSchedule } from './schedule-service.js'
import type { TaskRuntime } from './task-runtime.js'

/**
 * 定时调度器。
 *
 * 每个启用的定时配置对应一个 croner 任务；回调只做一件事：
 * 调用 `runSchedule` 创建正式 CrawlTask，然后刷新下次执行时间。
 * 采集本身由 TaskRuntime 在后台按并发规则执行。
 *
 * 服务重启后由 `start()` 重新注册全部启用的配置（配置来自数据库，
 * 不依赖内存状态）；停用的配置不注册，避免遗留计时器。
 */
export class TaskScheduler {
  private readonly jobs = new Map<number, Cron>()
  private readonly firing = new Set<number>()
  private started = false

  constructor(
    private readonly runtime: TaskRuntime,
    private readonly logger: Logger,
  ) {}

  get jobCount(): number {
    return this.jobs.size
  }

  /** 注册全部启用的定时任务，返回注册数量。 */
  start(): number {
    this.started = true
    const rows = getModels().crawlSchedule.findMany({ enabled: 1 })
    for (const row of rows) {
      try {
        this.sync(row.id)
      } catch (error) {
        this.logger.error(`注册定时任务 ${row.id} 失败`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return this.jobs.size
  }

  /** 重新同步单个配置（创建 / 修改 / 启停后调用）。 */
  sync(id: number): void {
    this.remove(id)
    const row = getScheduleRow(id)
    if (row.enabled !== 1 || !row.cron) {
      getModels().crawlSchedule.update(id, { nextRunAt: null })
      return
    }

    try {
      const job = new Cron(
        row.cron,
        { timezone: row.timezone ?? undefined, paused: !this.started },
        () => {
          void this.fire(id)
        },
      )
      this.jobs.set(id, job)
      const next = job.nextRun()
      getModels().crawlSchedule.update(id, { nextRunAt: next ? next.toISOString() : null })
    } catch (error) {
      getModels().crawlSchedule.update(id, { nextRunAt: null })
      writeLog({
        siteId: row.siteId,
        level: 'error',
        stage: 'schedule',
        message: `定时任务「${row.name}」注册失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /** 移除配置对应的计时器。 */
  remove(id: number): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.stop()
    this.jobs.delete(id)
  }

  /** 停止全部计时器。 */
  stop(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    this.started = false
  }

  /** 立即触发一次（测试与「立即运行」按钮共用，走同一条创建任务路径）。 */
  async fireNow(id: number): Promise<ReturnType<typeof runSchedule>> {
    return this.fire(id, 'schedule')
  }

  private async fire(id: number, trigger: 'schedule' | 'manual' = 'schedule'): Promise<ReturnType<typeof runSchedule>> {
    if (this.firing.has(id)) {
      return { task: null, skipped: true, reason: '上一次调度尚未结束' }
    }
    this.firing.add(id)
    try {
      const result = runSchedule(id, this.runtime, trigger)
      if (result.skipped) {
        this.logger.debug(`定时任务 ${id} 跳过`, { reason: result.reason })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`定时任务 ${id} 执行失败`, { error: message })
      writeLog({ level: 'error', stage: 'schedule', message: `定时任务 ${id} 触发失败：${message}` })
      return { task: null, skipped: true, reason: message }
    } finally {
      this.firing.delete(id)
      try {
        refreshNextRun(id)
      } catch {
        // 配置可能已被删除
      }
    }
  }
}
