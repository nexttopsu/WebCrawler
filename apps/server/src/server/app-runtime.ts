import type { RequestClient } from '../request/index.js'
import type { PluginRegistry } from '../plugin-system/index.js'
import type { AppConfig } from './config.js'
import type { Logger } from './lib/logger.js'
import { flushProxyStats, startProxyStatsFlusher } from './services/proxy-stats.js'
import { closeDebugCapture } from './services/debug-capture-service.js'
import { TaskRuntime, type RecoveryResult } from './services/task-runtime.js'
import { TaskScheduler } from './services/task-scheduler.js'
import { setProxySecretKey } from './lib/proxy-secret.js'

/**
 * 应用级后台运行时。
 *
 * 任务执行器与调度器都是长生命周期对象，由这里单例持有：
 * - `createApp` 负责构造（不启动调度、不做恢复）；
 * - `index.ts` 启动时调用 `startBackgroundJobs()`（恢复 + 注册定时）；
 * - 测试可以拿到同一个实例，用 `whenIdle()` 等待任务结束。
 */
export interface AppRuntime {
  tasks: TaskRuntime
  scheduler: TaskScheduler
  /** 调度器是否已启动 */
  scheduling: boolean
  stopStatsFlusher: (() => void) | null
}

let current: AppRuntime | null = null

export interface RuntimeInitOptions {
  config: AppConfig
  request: RequestClient
  logger: Logger
  /** 插件注册表：任务执行器用它解析规则里的解析器插件链 */
  pluginRegistry?: PluginRegistry
}

/** 创建（或替换）应用运行时。旧实例的定时器会被停止。 */
export function createAppRuntime(options: RuntimeInitOptions): AppRuntime {
  if (current) {
    current.scheduler.stop()
    current.stopStatsFlusher?.()
    current = null
  }

  setProxySecretKey(options.config.proxySecretKey)

  const tasks = new TaskRuntime({
    request: options.request,
    logger: options.logger,
    pluginRegistry: options.pluginRegistry,
    concurrency: options.config.taskConcurrency,
    siteConcurrency: options.config.taskSiteConcurrency,
    rateLimitMs: options.config.taskRateLimitMs,
  })

  current = {
    tasks,
    scheduler: new TaskScheduler(tasks, options.logger),
    scheduling: false,
    stopStatsFlusher: null,
  }
  return current
}

export function getAppRuntime(): AppRuntime {
  if (!current) throw new Error('应用运行时尚未初始化，请先调用 createApp()')
  return current
}

/** 清空单例（测试在关闭数据库前调用）。 */
export function resetAppRuntime(): void {
  if (!current) return
  current.scheduler.stop()
  current.stopStatsFlusher?.()
  current = null
}

export interface BackgroundStartResult {
  recovery: RecoveryResult
  schedules: number
}

/**
 * 启动后台作业：恢复任务状态、注册定时任务、启动代理统计刷盘。
 *
 * 恢复策略见 `TaskRuntime.recover()`：running → failed（保留断点），
 * pending → 重新排队，paused → 保持暂停。
 */
export function startBackgroundJobs(options: { scheduler?: boolean } = {}): BackgroundStartResult {
  const runtime = getAppRuntime()
  const recovery = runtime.tasks.recover()
  const schedules = options.scheduler === false ? 0 : runtime.scheduler.start()
  runtime.scheduling = options.scheduler !== false
  runtime.stopStatsFlusher = startProxyStatsFlusher()
  return { recovery, schedules }
}

/** 停机：停止调度、中止任务、刷盘统计、关掉捕获浏览器。 */
export async function stopBackgroundJobs(): Promise<void> {
  if (!current) return
  current.scheduler.stop()
  current.scheduling = false
  current.stopStatsFlusher?.()
  current.stopStatsFlusher = null
  await current.tasks.stop()
  flushProxyStats()
  // 捕获浏览器是用户手动开的窗口：进程退出时必须一起关掉，否则会留下孤儿 Chromium
  await closeDebugCapture()
}
