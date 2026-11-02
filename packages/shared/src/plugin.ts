/**
 * 插件管理的对外结构。
 *
 * 密码类配置不会出现在这里：插件的 `config` 由服务端做敏感字段脱敏后再返回。
 */
import type { PluginType } from './domain.js'

/** 插件清单状态。 */
export type PluginStatus = 'enabled' | 'disabled' | 'incompatible' | 'invalid'

/** 插件列表项。 */
export interface PluginDto {
  id: number | null
  name: string
  version: string
  type: PluginType | string
  /** 插件入口（文件路径或模块名），为空表示内置插件 */
  entry: string | null
  description: string | null
  /** 兼容的核心版本范围，例如 `^0.5.0` */
  coreVersion: string | null
  /** 是否已在运行时注册表中 */
  registered: boolean
  enabled: boolean
  status: PluginStatus
  /** 不兼容或加载失败的原因 */
  error: string | null
  config: Record<string, unknown> | null
  createdAt: string | null
  updatedAt: string | null
}

/** 扫描/刷新结果。 */
export interface PluginScanResultDto {
  scannedAt: string
  /** 扫描的目录 */
  directory: string
  /** 目录是否存在；不存在时视为「没有本地插件」，不是错误 */
  exists: boolean
  found: number
  added: number
  updated: number
  /** 加载失败（清单非法、核心版本不兼容、同名重复等） */
  failed: Array<{ name: string; path: string; error: string }>
}

/** 插件错误日志条目。 */
export interface PluginErrorDto {
  id: number
  level: string
  stage: string
  message: string
  detail: Record<string, unknown> | null
  createdAt: string
}
