import { apiRequest } from './http'
import type { HealthPayload, SystemInfoPayload } from './types'

/** 健康检查。 */
export function fetchHealth(): Promise<HealthPayload> {
  return apiRequest<HealthPayload>('/health')
}

/** 系统信息；`verbose` 为真时服务端会附带内存与配置细节。 */
export function fetchSystemInfo(verbose = false): Promise<SystemInfoPayload> {
  return apiRequest<SystemInfoPayload>(`/system/info${verbose ? '?verbose=true' : ''}`)
}
