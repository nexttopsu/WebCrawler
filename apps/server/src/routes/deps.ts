import type { RequestClient } from '@webcrawler/request'
import type { AppConfig } from '../config.js'
import type { Logger } from '../lib/logger.js'
import type { TaskRuntime } from '../services/task-runtime.js'
import type { TaskScheduler } from '../services/task-scheduler.js'

/**
 * 路由共享依赖。
 *
 * 路由只做「解析输入 → 调用服务 → 返回结果」，请求客户端、运行时与调度器
 * 都由组装层注入，路由本身不创建任何长生命周期对象。
 */
export interface ServiceDeps {
  request: RequestClient
  allowPrivateNetwork: boolean
  runtime: TaskRuntime
  scheduler: TaskScheduler
  logger: Logger
  config: AppConfig
}
