/**
 * 系统设置。
 *
 * 只读写白名单内的键：未知键直接 400，避免把 `system_setting` 变成任意的 KV 存储。
 * 每项都标注生效方式：
 * - `immediate`：写库后立刻作用到运行时（并发、限速、日志级别、时区、默认代理）；
 * - `new-task`：只影响之后创建的任务（重试次数、单任务时长）；
 * - `readonly`：来自环境变量或运行环境，界面只展示。
 *
 * 敏感信息一律不落在这里：默认代理只存 `proxyId`，密码仍在代理表内加密。
 */
import { getDatabaseContext, getModels, type SystemSettingRow } from '@webcrawler/database'
import type {
  SettingControl,
  SettingEffect,
  SettingGroup,
  SystemSettingItemDto,
  SystemSettingsDto,
} from '@webcrawler/shared'
import { z } from 'zod'
import type { AppConfig, LogLevel } from '../config.js'
import { ValidationError } from '../errors.js'
import type { Logger } from '../lib/logger.js'
import { pruneCrawlLogs } from './log-service.js'

/* -------------------------------------------------------------------------- */
/* 定义                                                                       */
/* -------------------------------------------------------------------------- */

export const SETTING_KEYS = {
  requestTimeoutMs: 'request.timeoutMs',
  taskConcurrency: 'task.concurrency',
  taskSiteConcurrency: 'task.siteConcurrency',
  taskRateLimitMs: 'task.rateLimitMs',
  taskRetries: 'task.retries',
  taskMaxDurationMs: 'task.maxDurationMs',
  browserHeadless: 'browser.headless',
  logLevel: 'log.level',
  logRetentionDays: 'log.retentionDays',
  timeZone: 'system.timezone',
  defaultProxyId: 'system.defaultProxyId',
} as const

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]

interface DefinitionBase {
  key: SettingKey
  label: string
  group: SettingGroup
  control: SettingControl
  effect: SettingEffect
  description: string
  min?: number
  max?: number
  unit?: string
  options?: Array<{ label: string; value: string }>
}

type Definition = DefinitionBase

const DEFINITIONS: Definition[] = [
  {
    key: SETTING_KEYS.requestTimeoutMs,
    label: '默认请求超时',
    group: 'request',
    control: 'number',
    effect: 'immediate',
    min: 1000,
    max: 120_000,
    unit: '毫秒',
    description: '站点连接测试、代理测试与未显式配置超时的试采使用该值。',
  },
  {
    key: SETTING_KEYS.taskConcurrency,
    label: '任务并发数',
    group: 'task',
    control: 'number',
    effect: 'immediate',
    min: 1,
    max: 32,
    unit: '个',
    description: '同一时刻最多运行的任务数；调小后已在跑的任务不会被打断。',
  },
  {
    key: SETTING_KEYS.taskSiteConcurrency,
    label: '单站点并发数',
    group: 'task',
    control: 'number',
    effect: 'immediate',
    min: 1,
    max: 16,
    unit: '个',
    description: '同一个站点同时运行的任务数，避免对单站点过度施压。',
  },
  {
    key: SETTING_KEYS.taskRateLimitMs,
    label: '栏目请求间隔',
    group: 'task',
    control: 'number',
    effect: 'immediate',
    min: 0,
    max: 60_000,
    unit: '毫秒',
    description: '同一栏目两次请求之间的最小间隔，只对新建任务生效。',
  },
  {
    key: SETTING_KEYS.taskRetries,
    label: '单篇失败重试',
    group: 'task',
    control: 'number',
    effect: 'new-task',
    min: 0,
    max: 5,
    unit: '次',
    description: '单篇文章抓取失败后的重试次数，只对新建任务生效。',
  },
  {
    key: SETTING_KEYS.taskMaxDurationMs,
    label: '单任务时长上限',
    group: 'task',
    control: 'number',
    effect: 'new-task',
    min: 60_000,
    max: 86_400_000,
    unit: '毫秒',
    description: '超过后任务被判为超时失败，只对新建任务生效。',
  },
  {
    key: SETTING_KEYS.browserHeadless,
    label: '浏览器无头模式',
    group: 'browser',
    control: 'switch',
    effect: 'immediate',
    description: '浏览器模式采集与测试是否以无头方式启动；关闭后需要图形环境。',
  },
  {
    key: SETTING_KEYS.logLevel,
    label: '日志级别',
    group: 'log',
    control: 'select',
    effect: 'immediate',
    options: [
      { label: 'debug', value: 'debug' },
      { label: 'info', value: 'info' },
      { label: 'warn', value: 'warn' },
      { label: 'error', value: 'error' },
    ],
    description: '进程日志的输出阈值，保存后立即生效。',
  },
  {
    key: SETTING_KEYS.logRetentionDays,
    label: '日志保留天数',
    group: 'log',
    control: 'number',
    effect: 'immediate',
    min: 0,
    max: 365,
    unit: '天',
    description: '任务日志保留天数，保存时立即清理过期记录；0 表示不清理。',
  },
  {
    key: SETTING_KEYS.timeZone,
    label: '时区',
    group: 'system',
    control: 'text',
    effect: 'immediate',
    description: '定时任务默认时区（IANA 名称，如 Asia/Shanghai）；留空则使用系统时区。',
  },
  {
    key: SETTING_KEYS.defaultProxyId,
    label: '默认代理',
    group: 'system',
    control: 'proxy',
    effect: 'immediate',
    description: '站点与栏目都未指定代理时使用的系统级代理；密码不会回显。',
  },
]

const DEFINITION_MAP = new Map(DEFINITIONS.map((item) => [item.key, item]))

/* -------------------------------------------------------------------------- */
/* 默认值与缓存                                                               */
/* -------------------------------------------------------------------------- */

export interface SettingDefaults {
  requestTimeoutMs: number
  taskConcurrency: number
  taskSiteConcurrency: number
  taskRateLimitMs: number
  taskRetries: number
  taskMaxDurationMs: number
  browserHeadless: boolean
  logLevel: LogLevel
  logRetentionDays: number
  timeZone: string
  defaultProxyId: number | null
}

export interface SettingValues extends SettingDefaults {}

let defaults: SettingDefaults = {
  requestTimeoutMs: 15_000,
  taskConcurrency: 2,
  taskSiteConcurrency: 1,
  taskRateLimitMs: 300,
  taskRetries: 1,
  taskMaxDurationMs: 30 * 60 * 1000,
  browserHeadless: true,
  logLevel: 'info',
  logRetentionDays: 30,
  timeZone: '',
  defaultProxyId: null,
}

let cache: SettingValues | null = null

/** 由 createApp 注入真实配置，保证设置页展示的默认值与实际运行一致。 */
export function setSettingDefaults(config: AppConfig): void {
  defaults = {
    requestTimeoutMs: 15_000,
    taskConcurrency: config.taskConcurrency,
    taskSiteConcurrency: config.taskSiteConcurrency,
    taskRateLimitMs: config.taskRateLimitMs,
    taskRetries: 1,
    taskMaxDurationMs: 30 * 60 * 1000,
    browserHeadless: true,
    logLevel: config.logLevel,
    logRetentionDays: 30,
    timeZone: '',
    defaultProxyId: null,
  }
  cache = null
}

export function invalidateSettingsCache(): void {
  cache = null
}

/* -------------------------------------------------------------------------- */
/* 读写                                                                       */
/* -------------------------------------------------------------------------- */

const INTEGER_COERCE = z.coerce.number().int()

function coerceValue(key: SettingKey, raw: string): string | number | boolean | null {
  switch (key) {
    case SETTING_KEYS.taskConcurrency:
    case SETTING_KEYS.taskSiteConcurrency:
    case SETTING_KEYS.taskRateLimitMs:
    case SETTING_KEYS.taskRetries:
    case SETTING_KEYS.taskMaxDurationMs:
    case SETTING_KEYS.requestTimeoutMs:
    case SETTING_KEYS.logRetentionDays: {
      const parsed = INTEGER_COERCE.safeParse(raw)
      return parsed.success ? parsed.data : null
    }
    case SETTING_KEYS.browserHeadless:
      return raw === 'true' || raw === '1'
    case SETTING_KEYS.defaultProxyId: {
      const parsed = INTEGER_COERCE.safeParse(raw)
      return parsed.success ? parsed.data : null
    }
    default:
      return raw
  }
}

function numberOrDefault(value: string | number | boolean | null, fallback: number): number {
  // 注意：Number(null) 是 0，这里必须显式兜底，否则「没配置」会被当成 0
  if (value === null || value === undefined || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isValidTimeZone(value: string): boolean {
  if (!value) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * 读取生效值：数据库覆盖项 > 注入的默认值。
 *
 * 结果在内存中缓存，写入后失效；任务执行与试采都会频繁读取，不能每次都查库。
 */
export function getSettings(): SettingValues {
  if (cache) return cache

  const rows = getModels().systemSetting.findMany({}, { orderBy: 'settingKey', order: 'ASC' })
  const stored = new Map<string, string>()
  for (const row of rows) {
    if (row.settingKey) stored.set(row.settingKey, row.settingValue ?? '')
  }

  const read = (key: SettingKey): string | number | boolean | null => {
    const raw = stored.get(key)
    return raw === undefined ? null : coerceValue(key, raw)
  }

  const timeZoneRaw = read(SETTING_KEYS.timeZone)
  const timeZone = typeof timeZoneRaw === 'string' && isValidTimeZone(timeZoneRaw) ? timeZoneRaw : ''

  const proxyRaw = read(SETTING_KEYS.defaultProxyId)
  const defaultProxyId = typeof proxyRaw === 'number' && proxyRaw > 0 ? proxyRaw : null

  cache = {
    requestTimeoutMs: numberOrDefault(read(SETTING_KEYS.requestTimeoutMs), defaults.requestTimeoutMs),
    taskConcurrency: Math.max(1, numberOrDefault(read(SETTING_KEYS.taskConcurrency), defaults.taskConcurrency)),
    taskSiteConcurrency: Math.max(
      1,
      numberOrDefault(read(SETTING_KEYS.taskSiteConcurrency), defaults.taskSiteConcurrency),
    ),
    taskRateLimitMs: Math.max(0, numberOrDefault(read(SETTING_KEYS.taskRateLimitMs), defaults.taskRateLimitMs)),
    taskRetries: Math.max(0, numberOrDefault(read(SETTING_KEYS.taskRetries), defaults.taskRetries)),
    taskMaxDurationMs: Math.max(
      1000,
      numberOrDefault(read(SETTING_KEYS.taskMaxDurationMs), defaults.taskMaxDurationMs),
    ),
    browserHeadless:
      read(SETTING_KEYS.browserHeadless) === null
        ? defaults.browserHeadless
        : read(SETTING_KEYS.browserHeadless) === true,
    logLevel: (() => {
      const value = read(SETTING_KEYS.logLevel)
      return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
        ? value
        : defaults.logLevel
    })(),
    logRetentionDays: Math.max(
      0,
      numberOrDefault(read(SETTING_KEYS.logRetentionDays), defaults.logRetentionDays),
    ),
    timeZone,
    defaultProxyId,
  }
  return cache
}

/** 实际生效的时区：配置优先，其次 TZ 环境变量，最后系统时区。 */
export function effectiveTimeZone(): string {
  const configured = getSettings().timeZone
  if (configured) return configured
  const env = process.env.TZ?.trim()
  if (env && isValidTimeZone(env)) return env
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** 系统时区（不受配置影响），用于设置页展示「系统 / 生效」两行。 */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const patchSchema = z
  .object({
    [SETTING_KEYS.requestTimeoutMs]: z.number().int().min(1000).max(120_000).optional(),
    [SETTING_KEYS.taskConcurrency]: z.number().int().min(1).max(32).optional(),
    [SETTING_KEYS.taskSiteConcurrency]: z.number().int().min(1).max(16).optional(),
    [SETTING_KEYS.taskRateLimitMs]: z.number().int().min(0).max(60_000).optional(),
    [SETTING_KEYS.taskRetries]: z.number().int().min(0).max(5).optional(),
    [SETTING_KEYS.taskMaxDurationMs]: z.number().int().min(60_000).max(86_400_000).optional(),
    [SETTING_KEYS.browserHeadless]: z.boolean().optional(),
    [SETTING_KEYS.logLevel]: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    [SETTING_KEYS.logRetentionDays]: z.number().int().min(0).max(365).optional(),
    [SETTING_KEYS.timeZone]: z.string().trim().max(64).optional(),
    [SETTING_KEYS.defaultProxyId]: z.number().int().positive().nullable().optional(),
  })
  .strict()

export type SettingsPatchInput = z.infer<typeof patchSchema>

export function parseSettingsPatch(input: unknown): SettingsPatchInput {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const unknown = Object.keys(input).filter((key) => !DEFINITION_MAP.has(key as SettingKey))
    if (unknown.length > 0) {
      throw new ValidationError(`设置项不在可编辑白名单内：${unknown.join('、')}`, [
        { path: unknown[0] ?? '', message: '未知的设置项', code: 'unrecognized_keys' },
      ])
    }
  }

  const parsed = patchSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(
      '设置校验失败',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    )
  }
  return parsed.data
}

function persist(key: string, value: string | null, definition: Definition): void {
  const existing: SystemSettingRow | undefined = getModels().systemSetting.findOne({ settingKey: key })
  const payload = {
    settingKey: key,
    settingValue: value,
    description: definition.description,
    groupName: definition.group,
  }
  if (existing) getModels().systemSetting.update(existing.id, payload)
  else getModels().systemSetting.create(payload)
}

/**
 * 写入设置并返回最新快照。
 *
 * 只做「校验 + 落库 + 失效缓存」，真正作用到运行时由调用方执行
 * （见 `applySettings`），这样服务层可以单独测试。
 */
export function saveSettings(patch: SettingsPatchInput): SettingValues {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
    [string, string | number | boolean | null]
  >
  if (entries.length === 0) {
    throw new ValidationError('没有需要更新的设置项')
  }

  for (const [key, value] of entries) {
    const definition = DEFINITION_MAP.get(key as SettingKey)
    if (!definition) {
      throw new ValidationError(`未知的设置项：${key}`)
    }
    if (key === SETTING_KEYS.timeZone && typeof value === 'string' && !isValidTimeZone(value)) {
      throw new ValidationError(`时区不合法：${value}`)
    }
    if (key === SETTING_KEYS.defaultProxyId && typeof value === 'number') {
      const proxy = getModels().proxy.findById(value)
      if (!proxy) throw new ValidationError(`代理 ${value} 不存在`)
    }
    const serialized =
      value === null ? null : typeof value === 'boolean' ? String(value) : String(value)
    persist(key, serialized, definition)
  }

  invalidateSettingsCache()
  return getSettings()
}

/** 把设置作用到运行时。返回本次实际生效的项，便于接口回显。 */
export interface ApplyContext {
  runtime?: {
    applyDefaults(defaults: { rateLimitMs?: number; retries?: number; maxDurationMs?: number }): void
    setConcurrency(total: number, perSite: number): void
  }
  logger?: Logger
  config?: AppConfig
}

export function applySettings(values: SettingValues, context: ApplyContext): string[] {
  const applied: string[] = []

  if (context.runtime) {
    try {
      context.runtime.setConcurrency(values.taskConcurrency, values.taskSiteConcurrency)
      context.runtime.applyDefaults({
        rateLimitMs: values.taskRateLimitMs,
        retries: values.taskRetries,
        maxDurationMs: values.taskMaxDurationMs,
      })
      applied.push(
        SETTING_KEYS.taskConcurrency,
        SETTING_KEYS.taskSiteConcurrency,
        SETTING_KEYS.taskRateLimitMs,
        SETTING_KEYS.taskRetries,
        SETTING_KEYS.taskMaxDurationMs,
      )
    } catch {
      // 运行时已停机时忽略，设置仍已落库
    }
  }

  if (context.logger?.setLevel) {
    context.logger.setLevel(values.logLevel)
    if (context.config) context.config.logLevel = values.logLevel
    applied.push(SETTING_KEYS.logLevel)
  }

  if (values.logRetentionDays > 0) {
    pruneCrawlLogs(values.logRetentionDays)
    applied.push(SETTING_KEYS.logRetentionDays)
  }

  applied.push(SETTING_KEYS.timeZone, SETTING_KEYS.defaultProxyId, SETTING_KEYS.browserHeadless)
  return applied
}

/* -------------------------------------------------------------------------- */
/* DTO                                                                        */
/* -------------------------------------------------------------------------- */

function currentValue(key: SettingKey, values: SettingValues): string | number | boolean | null {
  switch (key) {
    case SETTING_KEYS.requestTimeoutMs:
      return values.requestTimeoutMs
    case SETTING_KEYS.taskConcurrency:
      return values.taskConcurrency
    case SETTING_KEYS.taskSiteConcurrency:
      return values.taskSiteConcurrency
    case SETTING_KEYS.taskRateLimitMs:
      return values.taskRateLimitMs
    case SETTING_KEYS.taskRetries:
      return values.taskRetries
    case SETTING_KEYS.taskMaxDurationMs:
      return values.taskMaxDurationMs
    case SETTING_KEYS.browserHeadless:
      return values.browserHeadless
    case SETTING_KEYS.logLevel:
      return values.logLevel
    case SETTING_KEYS.logRetentionDays:
      return values.logRetentionDays
    case SETTING_KEYS.timeZone:
      return values.timeZone
    case SETTING_KEYS.defaultProxyId:
      return values.defaultProxyId
    default:
      return null
  }
}

function defaultValue(key: SettingKey): string | number | boolean | null {
  switch (key) {
    case SETTING_KEYS.requestTimeoutMs:
      return defaults.requestTimeoutMs
    case SETTING_KEYS.taskConcurrency:
      return defaults.taskConcurrency
    case SETTING_KEYS.taskSiteConcurrency:
      return defaults.taskSiteConcurrency
    case SETTING_KEYS.taskRateLimitMs:
      return defaults.taskRateLimitMs
    case SETTING_KEYS.taskRetries:
      return defaults.taskRetries
    case SETTING_KEYS.taskMaxDurationMs:
      return defaults.taskMaxDurationMs
    case SETTING_KEYS.browserHeadless:
      return defaults.browserHeadless
    case SETTING_KEYS.logLevel:
      return defaults.logLevel
    case SETTING_KEYS.logRetentionDays:
      return defaults.logRetentionDays
    case SETTING_KEYS.timeZone:
      return defaults.timeZone
    case SETTING_KEYS.defaultProxyId:
      return defaults.defaultProxyId
    default:
      return null
  }
}

export function toSettingsItem(definition: Definition, values: SettingValues): SystemSettingItemDto {
  const base: SystemSettingItemDto = {
    key: definition.key,
    label: definition.label,
    group: definition.group,
    control: definition.control,
    effect: definition.effect,
    description: definition.description,
    editable: true,
    value: currentValue(definition.key, values),
    defaultValue: defaultValue(definition.key),
  }
  if (definition.min !== undefined) base.min = definition.min
  if (definition.max !== undefined) base.max = definition.max
  if (definition.unit) base.unit = definition.unit
  if (definition.options) base.options = definition.options
  return base
}

export function readSettings(): SettingValues {
  return getSettings()
}

/** 组装设置页需要的完整载荷（含只读运行信息）。 */
export function buildSettingsDto(config: AppConfig): SystemSettingsDto {
  const values = getSettings()
  const context = getDatabaseContext()
  return {
    items: DEFINITIONS.map((definition) => toSettingsItem(definition, values)),
    readonly: {
      version: config.version,
      env: config.env,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      databaseFile: context.file,
      schemaVersion: context.migrations.at(-1)?.id ?? 0,
      uptimeSeconds: Math.round(process.uptime()),
      systemTimeZone: systemTimeZone(),
      activeTimeZone: effectiveTimeZone(),
      proxySecretConfigured: config.proxySecretKey !== null,
    },
    updatedAt: new Date().toISOString(),
  }
}

export { DEFINITIONS as SETTING_DEFINITIONS }
