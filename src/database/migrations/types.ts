import type { Database } from 'ormlet'

/**
 * 一次数据库版本变更。
 *
 * 新增变更时追加一个 `id` 更大的迁移，不要修改已发布的迁移——
 * 已应用的迁移不会再次执行，改动不会对现有数据库生效。
 */
export interface Migration {
  /** 单调递增的版本号，从 1 开始 */
  id: number
  /** 变更名称，仅用于记录与排查 */
  name: string
  /** 执行变更。全部 SQL 应为幂等写法，便于在异常后重跑 */
  up: (db: Database) => void
}

/** 一条已应用的迁移记录。 */
export interface AppliedMigration {
  id: number
  name: string
  appliedAt: string
}
