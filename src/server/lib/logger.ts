import type { LogLevel } from '../config.js'

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  /** 运行时调整输出阈值（系统设置里改日志级别时使用） */
  setLevel?(level: LogLevel): void
  /** 当前阈值 */
  level?(): LogLevel
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/**
 * 基于 console 的极简结构化日志。
 * 第一阶段不引入日志框架：输出到 stdout / stderr 即可被进程管理器收集。
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  let current = level
  let threshold = LEVEL_WEIGHT[current]

  const write = (target: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[target] < threshold) return
    const line = `${new Date().toISOString()} ${target.toUpperCase().padEnd(5)} ${message}`
    if (meta) {
      console[target](line, meta)
    } else {
      console[target](line)
    }
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    setLevel: (next) => {
      current = next
      threshold = LEVEL_WEIGHT[next]
    },
    level: () => current,
  }
}
