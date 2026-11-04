import { resolve } from 'node:path'

export const APP_NAME = 'WebCrawler'
export const APP_VERSION = '0.7.0'

export type AppEnv = 'development' | 'production' | 'test'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AppConfig {
  name: string
  version: string
  env: AppEnv
  host: string
  port: number
  /** SQLite 文件路径，支持相对路径（相对进程工作目录） */
  databaseFile: string
  /** CORS 允许的来源：`'*'` 或白名单 */
  corsOrigins: '*' | string[]
  logLevel: LogLevel
  /**
   * 是否允许请求内网 / 回环地址。
   *
   * 仅供本地 fixture 测试与服务自检使用；生产环境必须保持 false，
   * 否则 SSRF 防护会失效。
   */
  allowPrivateNetwork: boolean
  /**
   * 代理密码加密密钥。
   *
   * 未配置时禁止写入带密码的代理（读取既有代理仍可用），
   * 绝不把密钥硬编码进仓库。
   */
  proxySecretKey: string | null
  /** 后台任务全局并发数 */
  taskConcurrency: number
  /** 单个站点同时运行的任务数 */
  taskSiteConcurrency: number
  /** 同一栏目两次请求的最小间隔（毫秒） */
  taskRateLimitMs: number
  /** 是否启动定时调度器（测试中关闭） */
  schedulerEnabled: boolean
  /** 代理连通性测试的默认目标地址 */
  proxyTestUrl: string
}

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

function parseEnv(raw: string | undefined): AppEnv {
  return raw === 'production' || raw === 'test' ? raw : 'development'
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`PORT 不是合法端口：${raw}`)
  }
  return port
}

function parseOrigins(raw: string | undefined): '*' | string[] {
  const value = raw?.trim()
  if (!value || value === '*') return '*'
  const origins = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return origins.length > 0 ? origins : '*'
}

function parseBoolean(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  return value === 'true' || value === '1' || value === 'yes'
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase()
  return LOG_LEVELS.find((level) => level === value) ?? 'info'
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  max = 1000,
): number {
  if (!raw?.trim()) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} 必须是 1-${max} 之间的整数，收到：${raw}`)
  }
  return value
}

/**
 * 从环境变量读取配置。所有字段都有默认值，本地开发零配置即可启动。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    env: parseEnv(env.NODE_ENV),
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT),
    databaseFile: env.DATABASE_FILE?.trim() || resolve(process.cwd(), 'data', 'webcrawler.db'),
    corsOrigins: parseOrigins(env.CORS_ORIGIN),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    allowPrivateNetwork: parseBoolean(env.ALLOW_PRIVATE_NETWORK),
    proxySecretKey: env.PROXY_SECRET_KEY?.trim() || null,
    taskConcurrency: parsePositiveInt(env.TASK_CONCURRENCY, 'TASK_CONCURRENCY', 2, 32),
    taskSiteConcurrency: parsePositiveInt(env.TASK_SITE_CONCURRENCY, 'TASK_SITE_CONCURRENCY', 1, 16),
    taskRateLimitMs: parsePositiveInt(env.TASK_RATE_LIMIT_MS, 'TASK_RATE_LIMIT_MS', 300, 60_000),
    schedulerEnabled: parseBoolean(env.SCHEDULER_ENABLED ?? 'true'),
    proxyTestUrl: env.PROXY_TEST_URL?.trim() || 'https://www.example.com',
  }
}
