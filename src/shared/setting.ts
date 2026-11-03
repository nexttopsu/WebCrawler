/**
 * 系统设置的对外结构。
 *
 * 设计原则：
 * - 只有白名单内的键可以读写，未知键直接 400；
 * - 每项都标注 `effect`（生效方式）与取值范围，前端据此渲染控件与提示；
 * - 不保存任何密钥类信息（代理密码只以 `defaultProxyId` 引用代理，密码仍在代理表里加密）。
 */

/** 设置分组，用于前端分栏。 */
export type SettingGroup = 'task' | 'request' | 'browser' | 'log' | 'system'

/** 生效方式。 */
export type SettingEffect = 'immediate' | 'new-task' | 'restart' | 'readonly'

/** 控件类型。 */
export type SettingControl = 'number' | 'switch' | 'select' | 'text' | 'proxy'

export interface SystemSettingItemDto {
  key: string
  label: string
  group: SettingGroup
  control: SettingControl
  /** 当前生效值 */
  value: string | number | boolean | null
  /** 出厂默认值，供「恢复默认」参考 */
  defaultValue: string | number | boolean | null
  effect: SettingEffect
  description: string
  editable: boolean
  min?: number
  max?: number
  unit?: string
  /** `control=select` 时的候选值 */
  options?: Array<{ label: string; value: string }>
}

/** 只读的运行信息，设置页顶部展示。 */
export interface SystemSettingReadonlyDto {
  version: string
  env: string
  node: string
  platform: string
  databaseFile: string
  schemaVersion: number
  uptimeSeconds: number
  /** 系统时区（未显式配置时的时间表默认时区） */
  systemTimeZone: string
  /** 实际生效的时区（配置优先） */
  activeTimeZone: string
  proxySecretConfigured: boolean
}

export interface SystemSettingsDto {
  items: SystemSettingItemDto[]
  readonly: SystemSettingReadonlyDto
  updatedAt: string
}

/** 更新请求：只允许出现白名单键。 */
export type SystemSettingsPatch = Record<string, string | number | boolean | null>
