/**
 * 插件管理。
 *
 * 第一版只做「本地目录扫描 + 注册表登记 + 启停 + 错误展示」：
 * - 不联网、不安装第三方包、不做插件市场；
 * - 清单非法或核心版本不兼容时，登记为禁用并记录原因，绝不让服务启动失败；
 * - 插件代码本身不由这里加载（加载器留给后续阶段），这里只维护清单与状态。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getDatabaseContext } from '@webcrawler/database'
import { getModels, type PluginRow } from '@webcrawler/database'
import { PLUGINS_PACKAGE, type PluginManifest, type PluginRegistry } from '@webcrawler/plugins'
import { PluginType, type PluginDto, type PluginScanResultDto, type PluginStatus } from '@webcrawler/shared'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import { redactValue } from '../lib/redact.js'
import { writeLog } from './log-service.js'

/* -------------------------------------------------------------------------- */
/* 输入                                                                       */
/* -------------------------------------------------------------------------- */

export const pluginListQuerySchema = z.object({
  ...paginationFields,
  keyword: keywordField,
  type: z.enum(['source', 'parser', 'exporter', 'hook']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  status: z.enum(['enabled', 'disabled', 'incompatible', 'invalid']).optional(),
})

export type PluginListQuery = z.infer<typeof pluginListQuerySchema>

export const pluginStatusSchema = z
  .object({ enabled: z.boolean() })
  .strict()

/* -------------------------------------------------------------------------- */
/* 版本范围                                                                   */
/* -------------------------------------------------------------------------- */

function parseVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

/**
 * 判断版本是否满足范围表达式。
 *
 * 支持 `*`、精确版本、`^`、`~`、`>=`、`>`、`<=`、`<`，以及用 `||` 连接的多个范围。
 * 这是给插件清单做「兼容性提示」用的最小实现，不追求完整的 semver 语义。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const current = parseVersion(version)
  if (!current) return true
  const expression = range.trim()
  if (!expression || expression === '*') return true

  return expression.split('||').some((part) => {
    const token = part.trim()
    if (!token) return true
    if (token === '*' || token === 'x') return true

    const operator = /^(\^|~|>=|>|<=|<|=)?\s*(.+)$/.exec(token)
    if (!operator) return false
    const [, op = '', rawTarget = ''] = operator
    const target = parseVersion(rawTarget.replace(/^v/, ''))
    if (!target) return true

    switch (op) {
      case '^': {
        if (current[0] !== target[0]) return false
        if (target[0] === 0 && current[1] !== target[1]) return false
        return compareVersion(current, target) >= 0
      }
      case '~': {
        if (current[0] !== target[0] || current[1] !== target[1]) return false
        return compareVersion(current, target) >= 0
      }
      case '>':
        return compareVersion(current, target) > 0
      case '>=':
        return compareVersion(current, target) >= 0
      case '<':
        return compareVersion(current, target) < 0
      case '<=':
        return compareVersion(current, target) <= 0
      default:
        return compareVersion(current, target) === 0
    }
  })
}

/* -------------------------------------------------------------------------- */
/* 清单读写                                                                   */
/* -------------------------------------------------------------------------- */

interface ManifestFile {
  name: string
  version: string
  type: string
  entry?: string
  description?: string
  coreVersion?: string
  config?: Record<string, unknown>
}

const manifestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, '插件名只能包含字母、数字、点、下划线与短横线'),
    version: z.string().trim().regex(/^\d+\.\d+\.\d+/, '版本号需形如 1.0.0'),
    type: z.enum(['source', 'parser', 'exporter', 'hook']),
    entry: z.string().trim().max(200).optional(),
    description: z.string().trim().max(200).optional(),
    coreVersion: z.string().trim().max(40).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

function emptyResult(directory: string, exists: boolean): PluginScanResultDto {
  return {
    scannedAt: new Date().toISOString(),
    directory,
    exists,
    found: 0,
    added: 0,
    updated: 0,
    failed: [],
  }
}

function readManifestFile(path: string): ManifestFile {
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`${issue?.path.join('.') || 'manifest'}：${issue?.message ?? '清单不合法'}`)
  }
  return result.data as ManifestFile
}

function toManifest(file: ManifestFile, entry: string): PluginManifest {
  return {
    name: file.name,
    version: file.version,
    type: file.type as PluginManifest['type'],
    entry,
    ...(file.description ? { description: file.description } : {}),
    ...(file.coreVersion ? { coreVersion: file.coreVersion } : {}),
    ...(file.config ? { config: file.config } : {}),
  }
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                       */
/* -------------------------------------------------------------------------- */

function statusOf(row: PluginRow, registered: boolean): PluginStatus {
  if (row.enabled !== 1) return 'disabled'
  return registered ? 'enabled' : 'invalid'
}

function toPluginDto(row: PluginRow, registered: boolean, error: string | null): PluginDto {
  return {
    id: row.id,
    name: row.name ?? '',
    version: row.version ?? '0.0.0',
    type: row.type ?? PluginType.SOURCE,
    entry: row.entry,
    description: row.description,
    coreVersion: readCoreVersion(row),
    registered,
    enabled: row.enabled === 1,
    status: statusOf(row, registered),
    error,
    config: parseConfig(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function readCoreVersion(row: PluginRow): string | null {
  const config = parseConfig(row.config)
  const value = config?.coreVersion
  return typeof value === 'string' && value ? value : null
}

function parseConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return redactValue(parsed) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 最近一次加载失败的原因（来自日志表，按插件名检索）。 */
function lastErrorMap(): Map<string, string> {
  const db = getDatabaseContext().db
  const rows = db
    .prepare(
      "SELECT message FROM crawl_log WHERE stage = 'plugin' AND level = 'error' ORDER BY id DESC LIMIT 200",
    )
    .all() as Array<{ message: string | null }>
  const map = new Map<string, string>()
  for (const row of rows) {
    const message = row.message ?? ''
    const match = /^插件\s+([^\s：]+)[：:]/.exec(message)
    if (!match) continue
    const name = match[1]!
    if (!map.has(name)) map.set(name, message)
  }
  return map
}

const PLUGIN_COLUMNS = 'id, name, version, type, entry, enabled, description, config, createdAt, updatedAt'

export function listPlugins(query: PluginListQuery, registry: PluginRegistry) {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.keyword) {
    conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
    const pattern = likePattern(query.keyword)
    params.push(pattern, pattern)
  }
  if (query.type) {
    conditions.push('type = ?')
    params.push(query.type)
  }
  if (query.enabled) {
    conditions.push('enabled = ?')
    params.push(query.enabled === 'true' ? 1 : 0)
  }

  const { rows, total } = runRawList<PluginRow>(getDatabaseContext().db, {
    select: PLUGIN_COLUMNS,
    from: 'plugin',
    conditions,
    params,
    orderBy: 'name ASC',
    page: query.page,
    pageSize: query.pageSize,
  })

  const errors = lastErrorMap()
  const items = rows
    .map((row) => toPluginDto(row, registry.get(row.name ?? '') !== undefined, errors.get(row.name ?? '') ?? null))
    .filter((item) => (query.status ? item.status === query.status : true))

  return toPage(items, query.status ? items.length : total, query.page, query.pageSize)
}

export function getPlugin(name: string, registry: PluginRegistry): PluginDto {
  const row = getModels().plugin.findOne({ name })
  if (!row) throw new NotFoundError(`插件 ${name} 不存在`)
  const errors = lastErrorMap()
  return toPluginDto(row, registry.get(name) !== undefined, errors.get(name) ?? null)
}

/* -------------------------------------------------------------------------- */
/* 启停                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 启用 / 禁用插件。
 *
 * 禁用会从运行时注册表移除；启用时重新登记清单（不兼容的直接拒绝）。
 */
export function setPluginEnabled(name: string, enabled: boolean, registry: PluginRegistry): PluginDto {
  const row = getModels().plugin.findOne({ name })
  if (!row) throw new NotFoundError(`插件 ${name} 不存在`)

  if (enabled) {
    const coreVersion = readCoreVersion(row)
    if (coreVersion && !satisfiesRange(PLUGINS_PACKAGE.version, coreVersion)) {
      throw new ConflictError(`插件 ${name} 要求核心版本 ${coreVersion}，当前 ${PLUGINS_PACKAGE.version}`, {
        plugin: name,
        coreVersion,
        current: PLUGINS_PACKAGE.version,
      })
    }
    const manifest = toManifest(
      {
        name: name,
        version: row.version ?? '0.0.0',
        type: row.type ?? PluginType.SOURCE,
        ...(row.entry ? { entry: row.entry } : {}),
        ...(row.description ? { description: row.description } : {}),
        ...(coreVersion ? { coreVersion } : {}),
      },
      row.entry ?? '',
    )
    if (!registry.get(name)) {
      try {
        registry.register(manifest)
      } catch {
        // 已登记（并发）时忽略
      }
    }
  } else if (registry.get(name)) {
    registry.unregister(name)
  }

  const updated = getModels().plugin.update(row.id, { enabled: enabled ? 1 : 0 })
  if (!updated) throw new NotFoundError(`插件 ${name} 不存在`)

  writeLog({
    level: 'info',
    stage: 'plugin',
    message: `插件 ${name} 已${enabled ? '启用' : '禁用'}`,
  })
  return toPluginDto(updated, registry.get(name) !== undefined, null)
}

/* -------------------------------------------------------------------------- */
/* 扫描与刷新                                                                 */
/* -------------------------------------------------------------------------- */

interface UpsertOutcome {
  added: boolean
}

function upsertManifest(manifest: PluginManifest, directory: string): UpsertOutcome {
  const existing = getModels().plugin.findOne({ name: manifest.name })
  const config = JSON.stringify({
    ...(manifest.config ?? {}),
    ...(manifest.coreVersion ? { coreVersion: manifest.coreVersion } : {}),
    ...(manifest.entry ? { sourcePath: manifest.entry } : {}),
    ...(directory ? { scannedFrom: directory } : {}),
  })

  if (!existing) {
    getModels().plugin.create({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      entry: manifest.entry ?? null,
      enabled: 1,
      description: manifest.description ?? null,
      config,
    })
    return { added: true }
  }

  getModels().plugin.update(existing.id, {
    version: manifest.version,
    type: manifest.type,
    entry: manifest.entry ?? existing.entry,
    description: manifest.description ?? existing.description,
    config,
  })
  return { added: false }
}

/**
 * 扫描本地插件目录。
 *
 * 目录不存在视为「没有本地插件」，返回 `exists=false` 而不是报错；
 * 单个清单读取失败不影响其它插件，失败项在 `failed` 里逐条返回。
 */
export function scanPlugins(directory: string, registry: PluginRegistry): PluginScanResultDto {
  const target = resolve(directory)
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return emptyResult(target, false)
  }

  const result = emptyResult(target, true)
  const seen = new Set<string>()

  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(target, entry.name)
    const manifestPath = join(dir, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    result.found += 1
    let file: ManifestFile
    try {
      file = readManifestFile(manifestPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ name: entry.name, path: manifestPath, error: message })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${entry.name}：清单读取失败 - ${message}` })
      continue
    }

    if (seen.has(file.name)) {
      const message = `插件名 ${file.name} 与其它目录重复，已跳过`
      result.failed.push({ name: file.name, path: manifestPath, error: message })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${file.name}：${message}` })
      continue
    }
    seen.add(file.name)

    if (file.coreVersion && !satisfiesRange(PLUGINS_PACKAGE.version, file.coreVersion)) {
      const message = `要求核心版本 ${file.coreVersion}，当前 ${PLUGINS_PACKAGE.version}`
      result.failed.push({ name: file.name, path: manifestPath, error: message })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${file.name}：核心版本不兼容 - ${message}` })
      continue
    }

    try {
      const manifest = toManifest(file, manifestPath)
      const outcome = upsertManifest(manifest, dir)
      if (outcome.added) result.added += 1
      else result.updated += 1
      if (!registry.get(manifest.name)) registry.register(manifest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ name: file.name, path: manifestPath, error: message })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${file.name}：注册失败 - ${message}` })
    }
  }

  writeLog({
    level: 'info',
    stage: 'plugin',
    message: `插件扫描完成：发现 ${result.found} 个，新增 ${result.added} 个，更新 ${result.updated} 个，失败 ${result.failed.length} 个`,
    detail: { directory: target },
  })
  return result
}

/**
 * 用数据库里的启用插件重建注册表。
 *
 * 先清空再按启用状态登记，保证「禁用后刷新不会复活」。
 */
export function refreshPlugins(registry: PluginRegistry): { registered: number; failed: Array<{ name: string; error: string }> } {
  for (const manifest of registry.list()) registry.unregister(manifest.name)

  const rows = getModels().plugin.findMany({}, { orderBy: 'name', order: 'ASC' })
  const failed: Array<{ name: string; error: string }> = []
  let registered = 0

  for (const row of rows) {
    const name = row.name ?? ''
    if (!name || row.enabled !== 1) continue
    const coreVersion = readCoreVersion(row)
    if (coreVersion && !satisfiesRange(PLUGINS_PACKAGE.version, coreVersion)) {
      failed.push({ name, error: `要求核心版本 ${coreVersion}，当前 ${PLUGINS_PACKAGE.version}` })
      getModels().plugin.update(row.id, { enabled: 0 })
      writeLog({ level: 'error', stage: 'plugin', message: `插件 ${name}：核心版本不兼容，已自动禁用` })
      continue
    }
    try {
      registry.register(
        toManifest(
          {
            name,
            version: row.version ?? '0.0.0',
            type: row.type ?? PluginType.SOURCE,
            ...(row.entry ? { entry: row.entry } : {}),
            ...(row.description ? { description: row.description } : {}),
            ...(coreVersion ? { coreVersion } : {}),
          },
          row.entry ?? '',
        ),
      )
      registered += 1
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }

  writeLog({
    level: 'info',
    stage: 'plugin',
    message: `插件注册表已刷新：${registered} 个已登记，${failed.length} 个失败`,
  })
  return { registered, failed }
}

/** 插件错误日志。 */
export function listPluginErrors(name: string, limit = 20): Array<{ id: number; level: string; stage: string; message: string; detail: Record<string, unknown> | null; createdAt: string }> {
  const db = getDatabaseContext().db
  const rows = db
    .prepare(
      "SELECT id, level, stage, message, detail, createdAt FROM crawl_log WHERE stage = 'plugin' AND message LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
    )
    .all(likePattern(`插件 ${name}`), Math.min(Math.max(1, limit), 100)) as Array<{
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

/** 校验插件名（路径参数）。 */
export function assertPluginName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new ValidationError('插件名不合法')
  }
  return name
}
