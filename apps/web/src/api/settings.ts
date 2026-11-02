import type { StatsOverviewDto, SystemSettingsDto } from '@webcrawler/shared'
import { api } from './client'

/** 仪表盘总览：一次拿到计数、趋势、最近任务/错误与代理概览。 */
export function fetchOverview(days = 14): Promise<StatsOverviewDto> {
  return api.get<StatsOverviewDto>('/stats/overview', { days })
}

/** 系统设置（含只读运行信息）。 */
export function fetchSettings(): Promise<SystemSettingsDto> {
  return api.get<SystemSettingsDto>('/settings')
}

/** 保存设置；响应里 `applied` 标出本次真正生效的键。 */
export function updateSettings(patch: Record<string, string | number | boolean | null>): Promise<
  SystemSettingsDto & { applied: string[] }
> {
  return api.patch<SystemSettingsDto & { applied: string[] }>('/settings', patch)
}
