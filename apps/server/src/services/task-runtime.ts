import { getModels, type CrawlTaskRow } from '@webcrawler/database'
import { KeyedLimiter } from '@webcrawler/core'
import {
  CrawlTaskStatus,
  type CrawlTaskTrigger,
  type CreateTaskInput,
  type TaskDto,
} from '@webcrawler/shared'
import type { RequestClient } from '@webcrawler/request'
import { ConflictError } from '../errors.js'
import type { Logger } from '../lib/logger.js'
import { flushProxyStats } from './proxy-stats.js'
import {
  cancelTask,
  createTask,
  getTask,
  getTaskRow,
  normalizeTaskStatus,
  parseTaskSnapshot,
  patchTask,
  pauseTask,
  resumeTask,
  retryTask,
  type TaskDefaults,
} from './task-service.js'
import { siteExists, snapshotIsRunnable, TaskExecutor } from './task-executor.js'
import { writeLog } from './log-service.js'

export interface TaskRuntimeOptions {
  request: RequestClient
  logger: Logger
  /** 全局同时执行的任务数 */
  concurrency?: number
  /** 单站点同时执行的任务数 */
  siteConcurrency?: number
  /** 默认的栏目请求间隔 */
  rateLimitMs?: number
  /** 单篇失败重试次数 */
  retries?: number
  /** 任务总时长上限 */
  maxDurationMs?: number
}

interface RunningEntry {
  controller: AbortController
  pauseRequested: boolean
}

/** 恢复结果，供启动日志与测试断言。 */
export interface RecoveryResult {
  requeued: number[]
  failed: number[]
  paused: number[]
}

/**
 * 后台任务运行时。
 *
 * 职责：
 * - 队列与并发（全局 + 按站点）；
 * - 暂停 / 恢复 / 取消的控制信号；
 * - 启动恢复（running 任务标记失败、pending 重新排队）；
 * - 对外暴露「创建即排队」的便捷方法。
 *
 * 任务的实际抓取逻辑在 `TaskExecutor`，这里不碰解析与存储细节。
 */
export class TaskRuntime {
  private readonly executor: TaskExecutor
  private readonly gate: KeyedLimiter
  private readonly queue: number[] = []
  private readonly running = new Map<number, RunningEntry>()
  private readonly defaults: TaskDefaults
  private concurrency: number
  private starting = 0
  private stopped = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly options: TaskRuntimeOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 2)
    this.gate = new KeyedLimiter(this.concurrency, Math.max(1, options.siteConcurrency ?? 1))
    this.defaults = {
      rateLimitMs: options.rateLimitMs ?? 300,
      maxDurationMs: options.maxDurationMs ?? 30 * 60 * 1000,
      retries: options.retries ?? 1,
    }
    this.executor = new TaskExecutor({ request: options.request, logger: options.logger })
  }

  get activeCount(): number {
    return this.running.size + this.starting
  }

  get queuedCount(): number {
    return this.queue.length
  }

  /** 当前生效的并发上限（系统设置页回显用）。 */
  get limits(): { total: number; perKey: number } {
    return this.gate.limits
  }

  /**
   * 运行时调整并发上限。
   *
   * 调小不会中断已经在跑的任务：空闲名额自然回收后新任务才会排队。
   */
  setConcurrency(total: number, perSite: number): void {
    this.concurrency = Math.max(1, total)
    this.gate.setLimits(this.concurrency, Math.max(1, perSite))
    this.pump()
  }

  /** 调整新建任务的默认值（限速、重试、时长上限）。 */
  applyDefaults(patch: Partial<TaskDefaults>): void {
    if (patch.rateLimitMs !== undefined) this.defaults.rateLimitMs = patch.rateLimitMs
    if (patch.retries !== undefined) this.defaults.retries = patch.retries
    if (patch.maxDurationMs !== undefined) this.defaults.maxDurationMs = patch.maxDurationMs
  }

  /** 创建任务并立即排队。 */
  createTask(
    input: CreateTaskInput,
    options: { trigger?: CrawlTaskTrigger; scheduleId?: number | null } = {},
  ): TaskDto {
    const task = createTask(input, {
      ...options,
      defaults: this.defaults,
    })
    this.enqueue(task.id)
    return task
  }

  /** 把任务加入队列（重复入队会被忽略）。 */
  enqueue(taskId: number): void {
    if (this.stopped) return
    if (this.running.has(taskId) || this.queue.includes(taskId)) return
    this.queue.push(taskId)
    this.pump()
  }

  /** 暂停：先通知执行器停止分发，再落状态。 */
  pause(taskId: number): TaskDto {
    const entry = this.running.get(taskId)
    if (entry) entry.pauseRequested = true

    const status = normalizeTaskStatus(getTaskRow(taskId).status)
    if (status !== CrawlTaskStatus.RUNNING && status !== CrawlTaskStatus.PENDING) {
      throw new ConflictError(`只有 pending / running 状态的任务可以暂停，当前状态：${status}`, {
        taskId,
        status,
      })
    }

    try {
      const dto = pauseTask(taskId)
      this.removeFromQueue(taskId)
      return dto
    } catch (error) {
      // 执行器可能刚好完成：只有确实进入 paused 才算成功
      const current = normalizeTaskStatus(getTaskRow(taskId).status)
      if (current === CrawlTaskStatus.PAUSED) return this.toDto(taskId)
      throw error
    }
  }

  /** 恢复：回到 pending 重新排队，执行器按断点续跑。 */
  resume(taskId: number): TaskDto {
    const dto = resumeTask(taskId)
    this.enqueue(taskId)
    return dto
  }

  /** 取消：abort 当前请求，状态立即置为 cancelled。 */
  cancel(taskId: number): TaskDto {
    const entry = this.running.get(taskId)
    if (entry) entry.controller.abort()

    const status = normalizeTaskStatus(getTaskRow(taskId).status)
    if (
      status !== CrawlTaskStatus.RUNNING &&
      status !== CrawlTaskStatus.PENDING &&
      status !== CrawlTaskStatus.PAUSED
    ) {
      throw new ConflictError(`当前状态 ${status} 的任务不能取消`, { taskId, status })
    }

    try {
      const dto = cancelTask(taskId)
      this.removeFromQueue(taskId)
      return dto
    } catch (error) {
      const current = normalizeTaskStatus(getTaskRow(taskId).status)
      if (current === CrawlTaskStatus.CANCELLED) return this.toDto(taskId)
      throw error
    }
  }

  /** 重试终态任务。 */
  retry(taskId: number): TaskDto {
    const dto = retryTask(taskId)
    this.enqueue(taskId)
    return dto
  }

  /**
   * 启动恢复。
   *
   * - `running`：进程重启前正在跑，无法安全续跑 → 标记 failed，保留断点供重试；
   * - `pending`：快照仍可用则重新排队，否则标记 failed；
   * - `paused`：保持暂停，由用户决定是否恢复；快照失效则标记 failed。
   */
  recover(): RecoveryResult {
    const result: RecoveryResult = { requeued: [], failed: [], paused: [] }
    const all = getModels().crawlTask.findMany({}, { orderBy: 'id', order: 'ASC' })

    for (const row of all) {
      const status = normalizeTaskStatus(row.status)
      if (status === CrawlTaskStatus.COMPLETED || status === CrawlTaskStatus.FAILED) continue

      const snapshot = parseTaskSnapshot(row.configSnapshot)
      const reason = !snapshot
        ? '任务缺少配置快照，无法恢复'
        : !siteExists(snapshot.siteId)
          ? '任务所属站点已不存在，无法恢复'
          : !snapshotIsRunnable(snapshot)
            ? '任务快照中的规则已不可执行（缺少列表项选择器）'
            : null

      if (status === CrawlTaskStatus.RUNNING) {
        // 不自动续跑：无法确定中断时请求的副作用，交给用户显式重试
        patchTask(row.id, {
          status: CrawlTaskStatus.FAILED,
          errorSummary: `服务重启导致任务中断${reason ? `：${reason}` : '，可查看断点后重试'}`,
          completedAt: new Date().toISOString(),
        })
        writeLog({
          taskId: row.id,
          level: 'error',
          stage: 'task',
          message: '服务启动时发现中断的任务，已标记为 failed',
        })
        result.failed.push(row.id)
        continue
      }

      if (reason) {
        patchTask(row.id, {
          status: CrawlTaskStatus.FAILED,
          errorSummary: reason,
          completedAt: new Date().toISOString(),
        })
        writeLog({ taskId: row.id, level: 'error', stage: 'task', message: `任务无法恢复：${reason}` })
        result.failed.push(row.id)
        continue
      }

      if (status === CrawlTaskStatus.PENDING) {
        this.enqueue(row.id)
        result.requeued.push(row.id)
      } else if (status === CrawlTaskStatus.PAUSED) {
        result.paused.push(row.id)
      }
    }

    return result
  }

  /** 等待队列清空且所有任务结束。 */
  whenIdle(timeoutMs = 60_000): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((item) => item !== waiter)
        reject(new Error('等待任务空闲超时，可能仍有任务在运行'))
      }, timeoutMs)
      timer.unref?.()

      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.idleWaiters.push(waiter)
    })
  }

  /** 停止运行时：中止全部任务并等待退出。 */
  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    for (const entry of this.running.values()) entry.controller.abort()
    try {
      await this.whenIdle(10_000)
    } catch {
      // 超时也要让进程退出
    }
    flushProxyStats()
  }

  /** 仅供测试：当前运行中的任务 id。 */
  get runningIds(): number[] {
    return [...this.running.keys()]
  }

  private async startTask(taskId: number): Promise<void> {
    if (this.stopped) return

    let row: CrawlTaskRow
    try {
      row = getTaskRow(taskId)
    } catch {
      return
    }
    if (normalizeTaskStatus(row.status) !== CrawlTaskStatus.PENDING) return

    const siteKey = String(row.siteId ?? 0)
    try {
      await this.gate.acquire(siteKey)
    } catch {
      return
    }

    try {
      // 排队期间可能被暂停/取消
      const latest = getTaskRow(taskId)
      if (normalizeTaskStatus(latest.status) !== CrawlTaskStatus.PENDING) return

      const controller = new AbortController()
      const entry: RunningEntry = { controller, pauseRequested: false }
      this.running.set(taskId, entry)

      await this.executor.run(taskId, {
        signal: controller.signal,
        shouldPause: () => entry.pauseRequested || this.stopped,
      })
    } catch (error) {
      this.options.logger.error(`任务 ${taskId} 执行异常`, {
        error: error instanceof Error ? error.message : String(error),
      })
      try {
        patchTask(taskId, {
          status: CrawlTaskStatus.FAILED,
          errorSummary: error instanceof Error ? error.message : String(error),
          completedAt: new Date().toISOString(),
        })
      } catch {
        // 数据库可能已关闭（停机中）
      }
    } finally {
      this.running.delete(taskId)
      this.gate.release(siteKey)
      this.notifyIdle()
      this.pump()
    }
  }

  private pump(): void {
    if (this.stopped) return
    while (this.queue.length > 0 && this.running.size + this.starting < this.concurrency) {
      const taskId = this.queue.shift()!
      this.starting += 1
      void this.startTask(taskId).finally(() => {
        this.starting -= 1
        this.notifyIdle()
        this.pump()
      })
    }
  }

  private removeFromQueue(taskId: number): void {
    const index = this.queue.indexOf(taskId)
    if (index >= 0) this.queue.splice(index, 1)
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running.size === 0 && this.starting === 0
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter()
  }

  private toDto(taskId: number): TaskDto {
    return getTask(taskId)
  }
}
