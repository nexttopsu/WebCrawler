import type { PackageInfo } from '@webcrawler/shared'

/** 服务端 `/api/system/info` 的返回载荷。 */
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
    driver: string
    file: string
    schemaVersion: number
    migrations: Array<{ id: number; name: string; appliedAt: string }>
    models: string[]
  }
  packages: PackageInfo[]
  plugins: {
    registered: number
    items: Array<{ name: string; version: string; type: string; description?: string }>
  }
  verbose?: {
    memory: Record<string, number>
    cwd: string
    config: { host: string; port: number; corsOrigins: '*' | string[] }
  }
}

/** 服务端 `/api/health` 的返回载荷。 */
export interface HealthPayload {
  status: 'ok'
  version: string
  uptimeSeconds: number
  timestamp: string
  database: {
    status: 'up'
    driver: string
    file: string
    latencyMs: number
  }
}
