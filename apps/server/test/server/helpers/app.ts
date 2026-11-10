/**
 * 服务端 API 测试助手。
 *
 * 每个测试文件独立初始化一个内存数据库与 H3 应用；
 * 需要访问本地 fixture 站点时传 `allowPrivateNetwork: true`（仅测试用）。
 */
import type { H3 } from 'h3'
import { closeDatabase, initDatabase } from '../../../src/database/index.js'
import { createApp } from '../../../src/server/app.js'
import { getAppRuntime, resetAppRuntime } from '../../../src/server/app-runtime.js'
import { loadConfig } from '../../../src/server/config.js'
import { createLogger } from '../../../src/server/lib/logger.js'
import type { TaskRuntime } from '../../../src/server/services/task-runtime.js'

export interface TestAppOptions {
  allowPrivateNetwork?: boolean
  /** 代理密码加密密钥；默认给一个测试值，未显式传 null 时都可用 */
  proxySecretKey?: string | null
  taskConcurrency?: number
  taskRateLimitMs?: number
}

export function startTestApp(options: TestAppOptions = {}): H3 {
  initDatabase({ file: ':memory:' })
  return createApp({
    config: {
      ...loadConfig({}),
      logLevel: 'error',
      // 调试数据用独立内存库：测试不会在仓库里留下 data/debug.db
      debugDatabaseFile: ':memory:',
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      proxySecretKey:
        options.proxySecretKey === undefined ? 'test-secret-key-0123456789' : options.proxySecretKey,
      taskConcurrency: options.taskConcurrency ?? 2,
      taskRateLimitMs: options.taskRateLimitMs ?? 0,
    },
    logger: createLogger('error'),
  })
}

/** 当前应用的任务运行时（与路由共用同一实例）。 */
export function getTestRuntime(): TaskRuntime {
  return getAppRuntime().tasks
}

export function stopTestApp(): void {
  resetAppRuntime()
  closeDatabase()
}

export interface JsonResponse {
  status: number
  headers: Headers
  body: any
}

/** 发起请求并解析统一响应结构。 */
export async function call(app: H3, path: string, init?: RequestInit): Promise<JsonResponse> {
  const response = await app.request(path, init)
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined,
  }
}

/** JSON 请求体。 */
export function json(data: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  }
}

/** 创建站点并返回响应体中的 data。 */
export async function createSite(app: H3, overrides: Record<string, unknown> = {}): Promise<any> {
  const response = await call(
    app,
    '/api/sites',
    json({
      name: '示例站点',
      domain: 'example.com',
      ...overrides,
    }),
  )
  if (response.status !== 201) {
    throw new Error(`创建站点失败：${JSON.stringify(response.body)}`)
  }
  return response.body.data
}

/** 创建栏目。 */
export async function createCategory(app: H3, input: Record<string, unknown>): Promise<any> {
  const response = await call(app, '/api/categories', json(input))
  if (response.status !== 201) {
    throw new Error(`创建栏目失败：${JSON.stringify(response.body)}`)
  }
  return response.body.data
}

/** 创建规则。 */
export async function createRule(app: H3, input: Record<string, unknown>): Promise<any> {
  const response = await call(app, '/api/rules', json(input))
  if (response.status !== 201) {
    throw new Error(`创建规则失败：${JSON.stringify(response.body)}`)
  }
  return response.body.data
}

/** 一份可用的最小规则配置。 */
export function sampleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    request: { mode: 'http', method: 'GET', timeoutMs: 5000 },
    list: {
      itemSelector: '.news-item',
      linkSelector: 'a',
      titleSelector: '.title',
      pagination: { type: 'none' },
    },
    detail: {
      fields: {
        title: { type: 'text', selector: 'h1', required: true },
        content: { type: 'html', selector: '.content' },
      },
    },
    ...overrides,
  }
}
