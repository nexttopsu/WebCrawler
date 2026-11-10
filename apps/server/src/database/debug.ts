import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Database } from 'ormlet'

/**
 * 调试数据专用库。
 *
 * 和业务库（`webcrawler.db`）**完全分开**：这里只有一张 `debug_sample` 表，
 * 用途单一 —— 按网址存档响应原文，采集 / 测试时命中即返回。
 * 需要清空时直接删掉 `data/debug.db` 即可，不会影响任何业务数据。
 *
 * 与业务库的差异：
 * - 不走 ORMlet 模型与迁移，建表语句写在本文件里（表结构简单且只此一张）；
 * - 允许 `:memory:`（测试用）：每次初始化都新建一个库，避免测试之间互相污染。
 */

export const DEBUG_SAMPLE_TABLE = 'debug_sample'

/** 调试库上下文。 */
export interface DebugDatabaseContext {
  db: Database
  file: string
}

const CREATE_DEBUG_SAMPLE = `
  CREATE TABLE IF NOT EXISTS ${DEBUG_SAMPLE_TABLE} (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    NOT NULL,
    raw         TEXT    NOT NULL DEFAULT '',
    statusCode  INTEGER NOT NULL DEFAULT 200,
    contentType TEXT    NOT NULL DEFAULT 'html',
    note        TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    hitCount    INTEGER NOT NULL DEFAULT 0,
    lastHitAt   TEXT,
    createdAt   TEXT    NOT NULL,
    updatedAt   TEXT    NOT NULL
  ) STRICT
`

/**
 * 网址唯一索引。
 *
 * 「网址完全匹配」是唯一查询方式，索引既是性能保证也是数据约束。
 * 建索引允许失败：存量库里若已有重复网址（手工导入等），
 * 查询仍按 `ORDER BY id DESC LIMIT 1` 取最新一条，不会因此启动失败。
 */
const CREATE_URL_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS ux_debug_sample_url ON ${DEBUG_SAMPLE_TABLE}(url)`

const CREATE_CREATED_AT_INDEX = `CREATE INDEX IF NOT EXISTS ix_debug_sample_created_at ON ${DEBUG_SAMPLE_TABLE}(createdAt)`

const MEMORY_FILES = new Set([':memory:', 'file::memory:', 'file::memory:?cache=shared'])

let context: DebugDatabaseContext | undefined

/**
 * 最近一次初始化用的文件路径。
 *
 * 连接关闭后仍然保留：调用方可以在「库被关掉 / 文件被删掉」之后按原路径重建，
 * 不必再猜一次配置（测试注入的 `:memory:` 也能原样重建）。
 */
let lastFile: string | undefined

function ensureParentDirectory(file: string): void {
  if (MEMORY_FILES.has(file) || file.startsWith('file:')) return
  mkdirSync(dirname(resolve(file)), { recursive: true })
}

/**
 * 初始化调试库（建库 + 建表 + 建索引）。
 *
 * 同一文件重复调用返回同一实例；`:memory:` 每次都会重建，
 * 让每个测试用例都拿到干净的库。
 */
export function initDebugDatabase(file: string): DebugDatabaseContext {
  const target = file.trim()
  if (!target) throw new Error('调试数据库文件路径不能为空')

  if (context && context.file === target && !MEMORY_FILES.has(target)) return context
  // 换文件或内存库：先关闭旧连接，避免句柄泄漏
  if (context) {
    context.db.close()
    context = undefined
  }

  ensureParentDirectory(target)
  const db = new Database(target, { busyTimeout: 5000, journalMode: 'WAL' })
  db.exec(CREATE_DEBUG_SAMPLE)
  try {
    db.exec(CREATE_URL_INDEX)
  } catch {
    // 已有重复网址时跳过：查询侧用 LIMIT 1 兜底
  }
  try {
    db.exec(CREATE_CREATED_AT_INDEX)
  } catch {
    // 索引失败不影响读写
  }

  context = { db, file: target }
  lastFile = target
  return context
}

/**
 * 确保调试库可用：已初始化直接复用，否则按给定文件建库建表。
 *
 * 用途是「自愈」：`data/debug.db` 被手工删掉、连接被提前关闭（测试 teardown、
 * 脚本里调用 `closeDatabase()`）之后，下一次读写会重新创建，而不是静默不命中。
 */
export function ensureDebugDatabase(file: string): DebugDatabaseContext {
  return context ?? initDebugDatabase(file)
}

/** 取最近一次初始化用的文件路径；进程内从未初始化时为 undefined。 */
export function lastDebugDatabaseFile(): string | undefined {
  return lastFile
}

/** 调试库是否已初始化。未初始化时采集流程应直接跳过命中查询。 */
export function isDebugDatabaseInitialized(): boolean {
  return context !== undefined
}

/** 取调试库连接；未初始化时抛错，避免业务层静默丢数据。 */
export function getDebugDatabase(): Database {
  if (!context) throw new Error('调试数据库尚未初始化，请先调用 initDebugDatabase()')
  return context.db
}

/** 关闭调试库。可重复调用。 */
export function closeDebugDatabase(): void {
  if (!context) return
  context.db.close()
  context = undefined
}
