import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Database } from 'ormlet'
import { defineModels, type DatabaseModels } from './models/index.js'
import { getAppliedMigrations, runMigrations, type AppliedMigration } from './migrations/index.js'

/** 打开数据库所需的配置。 */
export interface DatabaseConfig {
  /** 数据库文件路径；传 `':memory:'` 使用内存库（测试用） */
  file: string
  /** 锁等待时长（毫秒），默认 5000 */
  busyTimeout?: number
  /** 日志模式，默认 WAL */
  journalMode?: 'WAL' | 'DELETE' | 'MEMORY'
}

/** 初始化结果：连接、模型集合与迁移状态。 */
export interface DatabaseContext {
  db: Database
  models: DatabaseModels
  file: string
  migrations: readonly AppliedMigration[]
}

const MEMORY_FILES = new Set([':memory:', 'file::memory:', 'file::memory:?cache=shared'])

let context: DatabaseContext | undefined

/** 文件库需要保证父目录存在，否则 `node:sqlite` 打开连接时会直接失败。 */
function ensureParentDirectory(file: string): void {
  if (MEMORY_FILES.has(file) || file.startsWith('file:')) return
  mkdirSync(dirname(resolve(file)), { recursive: true })
}

/**
 * 初始化数据库：打开唯一连接、注册模型、执行迁移。
 *
 * 进程内只允许一个连接——重复调用同一路径返回同一实例，
 * 换路径则直接报错。业务模块通过 `getModels()` 取模型，不要自行创建连接。
 */
export function initDatabase(config: DatabaseConfig): DatabaseContext {
  const file = config.file.trim()
  if (!file) {
    throw new Error('数据库文件路径不能为空')
  }

  if (context) {
    if (context.file === file) return context
    throw new Error(`数据库已初始化为 ${context.file}，同一进程内不允许重复创建连接`)
  }

  ensureParentDirectory(file)

  const db = new Database(file, {
    busyTimeout: config.busyTimeout ?? 5000,
    journalMode: config.journalMode ?? 'WAL',
  })
  const models = defineModels(db)
  runMigrations(db)

  context = {
    db,
    models,
    file,
    migrations: getAppliedMigrations(db),
  }
  return context
}

/** 获取已初始化的数据库上下文，未初始化时抛出明确的错误。 */
export function getDatabaseContext(): DatabaseContext {
  if (!context) {
    throw new Error('数据库尚未初始化，请先调用 initDatabase()')
  }
  return context
}

/** 获取全部模型。 */
export function getModels(): DatabaseModels {
  return getDatabaseContext().models
}

/** 数据库是否已初始化。 */
export function isDatabaseInitialized(): boolean {
  return context !== undefined
}

/** 关闭连接并释放单例，主要供测试与进程退出使用。可重复调用。 */
export function closeDatabase(): void {
  if (!context) return
  context.db.close()
  context = undefined
}
