/**
 * 插件管理（内置插件）。
 *
 * 插件是服务端源码的一部分：`src/plugins/` 下任意层级的 `.ts` 文件用 `definePlugin` 定义并
 * `export default`，`src/plugins/index.ts` 在模块加载时自动扫描目录、汇总成清单，随服务端一起编译。
 *
 * - **启动时注册一次**：清单在模块加载时（顶层 await）就已就绪，`registerBuiltinPlugins()`
 *   在 `createApp` 里同步注册，之后运行期不再读文件、不再扫描目录；
 * - **数据库只存开关**：`plugin` 表只有 `pluginId + enabled`，
 *   名称、类型、支持位置一律来自源码，不存副本；
 * - **启停立即生效**：插件模块已经在内存里，启用 = 写回注册表，停用 = 从注册表移除。
 */
import { getDatabaseContext, getModels, type PluginRow } from '../../database/index.js'
import { builtinPluginFailures, builtinPlugins, type BuiltinPluginEntry } from '../../plugins/index.js'
import {
  pluginSlots,
  validatePluginModule,
  type PluginModule,
  type PluginRegistry,
  type RegisteredPlugin,
} from '../../plugin-system/index.js'
import type { PluginDto, PluginStatus } from '../../shared/index.js'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, paginationFields } from '../lib/query.js'
import { writeLog } from './log-service.js'

/* -------------------------------------------------------------------------- */
/* 输入                                                                       */
/* -------------------------------------------------------------------------- */

export const pluginListQuerySchema = z.object({
  ...paginationFields,
  keyword: keywordField,
  type: z.enum(['flow', 'parser']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  status: z.enum(['enabled', 'disabled', 'invalid']).optional(),
})

export type PluginListQuery = z.infer<typeof pluginListQuerySchema>

export const pluginStatusSchema = z.object({ enabled: z.boolean() }).strict()

/* -------------------------------------------------------------------------- */
/* 内置清单索引                                                               */
/* -------------------------------------------------------------------------- */

/** 按 id 建索引，供详情与启停使用；重复 id 在注册阶段会被报出来。 */
const builtinIndex = new Map<string, BuiltinPluginEntry>(
  builtinPlugins.map((entry) => [entry.plugin.config.id, entry]),
)

/** 数据库里的开关记录，按 pluginId 索引。 */
function switchRowMap(): Map<string, PluginRow> {
  const rows = getModels().plugin.findMany({})
  const map = new Map<string, PluginRow>()
  for (const row of rows) {
    if (row.pluginId) map.set(row.pluginId, row)
  }
  return map
}

/**
 * 是否启用。
 *
 * 没有记录的新插件视为启用：`registerBuiltinPlugins` 会补一行 enabled=1，
 * 这里保持同一口径，避免「刚注册完却显示停用」。
 */
function isEnabled(row: PluginRow | undefined): boolean {
  if (!row) return true
  return row.enabled === 1
}

function statusOf(problem: string | null, enabled: boolean): PluginStatus {
  if (problem) return 'invalid'
  return enabled ? 'enabled' : 'disabled'
}

function toPluginDto(
  entry: BuiltinPluginEntry,
  registry: PluginRegistry,
  row: PluginRow | undefined,
  problem: string | null,
): PluginDto {
  const plugin = entry.plugin
  const enabled = isEnabled(row)
  return {
    pluginId: plugin.config.id,
    name: plugin.config.name,
    version: plugin.config.version ?? '0.0.0',
    type: plugin.config.type,
    slots: pluginSlots(plugin),
    source: entry.source,
    description: plugin.config.description ?? null,
    enabled,
    registered: registry.get(plugin.config.id) !== undefined,
    status: statusOf(problem, enabled),
    error: problem,
    updatedAt: row?.updatedAt ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* 启动注册                                                                   */
/* -------------------------------------------------------------------------- */

export interface PluginRegisterResult {
  /** 成功进入注册表的插件数（停用的不算） */
  registered: number
  /** 实现有问题、没进注册表的插件 */
  failed: Array<{ pluginId: string; error: string }>
}

/**
 * 启动时注册全部内置插件。
 *
 * 只做三件事：校验实现 → 补开关记录 → 按启用状态写注册表。
 * 单个插件有问题只影响它自己：记日志、界面标成 invalid，其它插件照常工作。
 * 扫描阶段就失败的文件（import 抛错、没导出插件）先逐条写日志。
 */
export function registerBuiltinPlugins(registry: PluginRegistry): PluginRegisterResult {
  registry.clear()

  const failed: Array<{ pluginId: string; error: string }> = []

  for (const item of builtinPluginFailures) {
    failed.push({ pluginId: item.file, error: item.error })
    writeLog({ level: 'error', stage: 'plugin', message: `插件 ${item.file}：${item.error}` })
  }

  let registered = 0

  for (const entry of builtinPlugins) {
    const plugin = entry.plugin
    const id = plugin.config.id
    const problem = validatePluginModule(plugin)

    if (problem) {
      failed.push({ pluginId: id || entry.source, error: problem })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${id || entry.source}：${problem}` })
      continue
    }

    // 第一次见到的插件补一行开关记录，默认启用；已有的记录不动（尊重用户停用）
    let row = getModels().plugin.findOne({ pluginId: id })
    if (!row) row = getModels().plugin.create({ pluginId: id, enabled: 1 }) ?? undefined

    if (!isEnabled(row)) continue

    try {
      registry.register({ ...plugin, source: entry.source })
      registered += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ pluginId: id, error: message })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${id}：注册失败 - ${message}` })
    }
  }

  writeLog({
    level: 'info',
    stage: 'plugin',
    message: `内置插件已注册：${registered} 个启用，${failed.length} 个失败`,
  })
  return { registered, failed }
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                       */
/* -------------------------------------------------------------------------- */

/** 最近一次加载失败的原因（来自日志表，按插件 id 检索）。 */
function lastErrorMap(): Map<string, string> {
  const db = getDatabaseContext().db
  const rows = db
    .prepare("SELECT message FROM crawl_log WHERE stage = 'plugin' AND level = 'error' ORDER BY id DESC LIMIT 200")
    .all() as Array<{ message: string | null }>
  const map = new Map<string, string>()
  for (const row of rows) {
    const message = row.message ?? ''
    const match = /^插件\s+([^\s：]+)[：:]/.exec(message)
    if (!match) continue
    const id = match[1]!
    if (!map.has(id)) map.set(id, message)
  }
  return map
}

/** 插件列表。数据全部来自内置清单，数据库只提供开关状态。 */
export function listPlugins(query: PluginListQuery, registry: PluginRegistry) {
  const rows = switchRowMap()

  let items = builtinPlugins.map((entry) =>
    toPluginDto(entry, registry, rows.get(entry.plugin.config.id), validatePluginModule(entry.plugin)),
  )

  const keyword = query.keyword?.trim().toLowerCase()
  if (keyword) {
    items = items.filter((item) =>
      [item.pluginId, item.name, item.description ?? '', item.source].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    )
  }
  if (query.type) items = items.filter((item) => item.type === query.type)
  if (query.enabled) items = items.filter((item) => item.enabled === (query.enabled === 'true'))
  if (query.status) items = items.filter((item) => item.status === query.status)

  const total = items.length
  const pageSize = query.pageSize
  const page = Math.max(1, query.page)
  const start = (page - 1) * pageSize
  const pageItems = items.slice(start, start + pageSize)

  return {
    items: pageItems,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    // 没有 error 字段时补上，界面统一按这两种情况展示
    error: null,
  }
}

export function getPlugin(id: string, registry: PluginRegistry): PluginDto {
  const entry = builtinIndex.get(id)
  if (!entry) throw new NotFoundError(`插件 ${id} 不存在`)

  const row = getModels().plugin.findOne({ pluginId: id }) ?? undefined
  const error = lastErrorMap().get(id) ?? null
  return toPluginDto(entry, registry, row, error ?? validatePluginModule(entry.plugin))
}

/* -------------------------------------------------------------------------- */
/* 启停                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 启用 / 停用插件。
 *
 * 插件模块已经在内存里，所以这是纯内存操作：启用写回注册表，停用从注册表移除，
 * 不需要重新读文件，也不用重启服务。开关状态同时落库，进程重启后仍然保持。
 */
export function setPluginEnabled(id: string, enabled: boolean, registry: PluginRegistry): PluginDto {
  const entry = builtinIndex.get(id)
  if (!entry) throw new NotFoundError(`插件 ${id} 不存在`)

  const problem = validatePluginModule(entry.plugin)
  if (enabled && problem) {
    throw new ConflictError(`插件 ${id} 实现有问题，无法启用：${problem}`, { plugin: id })
  }

  const row = getModels().plugin.findOne({ pluginId: id })
  const value = enabled ? 1 : 0
  const updated = row ? getModels().plugin.update(row.id, { enabled: value }) : getModels().plugin.create({ pluginId: id, enabled: value })
  if (!updated) throw new NotFoundError(`插件 ${id} 不存在`)

  if (enabled) {
    if (!registry.get(id)) registry.register({ ...entry.plugin, source: entry.source })
  } else {
    registry.unregister(id)
  }

  writeLog({
    level: 'info',
    stage: 'plugin',
    message: `插件 ${id} 已${enabled ? '启用' : '停用'}`,
  })
  return toPluginDto(entry, registry, updated, problem)
}

/* -------------------------------------------------------------------------- */
/* 错误日志                                                                   */
/* -------------------------------------------------------------------------- */

/** 插件错误日志。 */
export function listPluginErrors(
  id: string,
  limit = 20,
): Array<{ id: number; level: string; stage: string; message: string; detail: Record<string, unknown> | null; createdAt: string }> {
  const db = getDatabaseContext().db
  const rows = db
    .prepare(
      "SELECT id, level, stage, message, detail, createdAt FROM crawl_log WHERE stage = 'plugin' AND message LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
    )
    .all(`%插件 ${id}%`, Math.min(Math.max(1, limit), 100)) as Array<{
    id: number
    level: string | null
    stage: string | null
    message: string | null
    detail: string | null
    createdAt: string | null
  }>

  return rows.map((row) => ({
    id: row.id,
    level: row.level ?? 'error',
    stage: row.stage ?? 'plugin',
    message: row.message ?? '',
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
    createdAt: row.createdAt ?? '',
  }))
}

/** 校验插件 id（路径参数）。 */
export function assertPluginName(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new ValidationError('插件 id 不合法')
  }
  return id
}

/** 内置插件数量（供系统信息展示）。 */
export function builtinPluginCount(): number {
  return builtinPlugins.length
}

export type { PluginModule, RegisteredPlugin }
