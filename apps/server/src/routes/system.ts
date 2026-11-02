import { z } from 'zod'
import { CORE_PACKAGE } from '@webcrawler/core'
import { DATABASE_PACKAGE, getDatabaseContext } from '@webcrawler/database'
import { PLUGINS_PACKAGE, type PluginManifest, type PluginRegistry } from '@webcrawler/plugins'
import { REQUEST_PACKAGE } from '@webcrawler/request'
import { SHARED_PACKAGE, type PackageInfo } from '@webcrawler/shared'
import { jsonOk } from '../lib/response.js'
import { parseQuery } from '../lib/validation.js'
import type { AppConfig } from '../config.js'
import type { ApiRoute } from './types.js'

/** 查询参数：`?verbose=true` 额外返回内存、工作目录等运行时细节。 */
const systemInfoQuerySchema = z.object({
  verbose: z.enum(['true', 'false'], { message: 'verbose 只能是 true 或 false' }).default('false'),
})

export interface SystemInfoPayload {
  name: string
  version: string
  env: string
  timestamp: string
  runtime: {
    node: string
    platform: string
    arch: string
    pid: number
    uptimeSeconds: number
  }
  database: {
    driver: 'sqlite'
    file: string
    /** 已应用的最大迁移版本号，0 表示还没有迁移记录 */
    schemaVersion: number
    migrations: Array<{ id: number; name: string; appliedAt: string }>
    models: string[]
  }
  /** 实际加载的工作空间包，用于确认模块引用是否生效 */
  packages: PackageInfo[]
  plugins: {
    registered: number
    items: PluginManifest[]
  }
  verbose?: {
    memory: Record<string, number>
    cwd: string
    config: {
      host: string
      port: number
      corsOrigins: '*' | string[]
    }
  }
}

const WORKSPACE_PACKAGES: PackageInfo[] = [
  SHARED_PACKAGE,
  DATABASE_PACKAGE,
  REQUEST_PACKAGE,
  CORE_PACKAGE,
  PLUGINS_PACKAGE,
]

/** 系统信息路由。 */
export function systemRoutes(config: AppConfig, registry: PluginRegistry): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/system/info',
      handler: (event) => {
        const { verbose } = parseQuery(event, systemInfoQuerySchema)
        const context = getDatabaseContext()

        const payload: SystemInfoPayload = {
          name: config.name,
          version: config.version,
          env: config.env,
          timestamp: new Date().toISOString(),
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
          },
          database: {
            driver: 'sqlite',
            file: context.file,
            schemaVersion: context.migrations.at(-1)?.id ?? 0,
            migrations: context.migrations.map((migration) => ({ ...migration })),
            models: Object.keys(context.models),
          },
          packages: WORKSPACE_PACKAGES,
          plugins: {
            registered: registry.size,
            items: registry.list(),
          },
        }

        if (verbose === 'true') {
          const memory = process.memoryUsage()
          payload.verbose = {
            memory: {
              rss: memory.rss,
              heapTotal: memory.heapTotal,
              heapUsed: memory.heapUsed,
              external: memory.external,
            },
            cwd: process.cwd(),
            config: {
              host: config.host,
              port: config.port,
              corsOrigins: config.corsOrigins,
            },
          }
        }

        return jsonOk(event, payload)
      },
    },
  ]
}
