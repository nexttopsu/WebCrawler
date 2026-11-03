import { getDatabaseContext } from '../../database/index.js'
import { DatabaseUnavailableError } from '../errors.js'
import { jsonOk } from '../lib/response.js'
import type { AppConfig } from '../config.js'
import type { ApiRoute } from './types.js'

export interface HealthPayload {
  status: 'ok'
  version: string
  uptimeSeconds: number
  timestamp: string
  database: {
    status: 'up'
    driver: 'sqlite'
    file: string
    /** 一次 `SELECT 1` 的耗时，用于判断数据库是否真的可读 */
    latencyMs: number
  }
}

/** 健康检查路由。 */
export function healthRoutes(config: AppConfig): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/health',
      handler: (event) => {
        const startedAt = performance.now()

        try {
          const { db, file } = getDatabaseContext()
          db.prepare('SELECT 1 AS ok').get()
          const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100

          return jsonOk<HealthPayload>(event, {
            status: 'ok',
            version: config.version,
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
            database: {
              status: 'up',
              driver: 'sqlite',
              file,
              latencyMs,
            },
          })
        } catch (error) {
          throw new DatabaseUnavailableError('数据库不可用', { cause: error })
        }
      },
    },
  ]
}
