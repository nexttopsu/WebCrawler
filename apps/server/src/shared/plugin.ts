/**
 * 插件管理的对外结构。
 *
 * 插件全部内置：列表来自 `src/plugins` 的静态清单，没有「扫描」「登记」这类写操作，
 * 所以结构里不再有配置 JSON、入口文件路径这些来自磁盘的字段。
 */
import type { PluginType } from './domain.js'

/** 插件状态：启用 / 用户手动停用 / 实现有问题 */
export type PluginStatus = 'enabled' | 'disabled' | 'invalid'

/** 插件列表项。 */
export interface PluginDto {
  /** 稳定标识：规则里引用它 */
  pluginId: string
  /** 显示名称 */
  name: string
  version: string
  type: PluginType | string
  /** 支持的位置（由实现的函数推导）：list = 列表、detail = 详情 */
  slots: Array<'list' | 'detail'>
  /** 内置源码位置，例如 `src/plugins/demo-fixture.ts` */
  source: string
  description: string | null
  /** 是否启用（用户在界面上控制，存数据库） */
  enabled: boolean
  /** 是否已在运行时注册表中 */
  registered: boolean
  status: PluginStatus
  /** 实现有问题时的原因 */
  error: string | null
  updatedAt: string | null
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
