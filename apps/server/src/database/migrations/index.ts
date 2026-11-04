import type { Database } from 'ormlet'
import { migration001InitialIndexes } from './001-initial-indexes.js'
import { migration002Stage3Upgrade } from './002-stage3-upgrade.js'
import { migration003Stage5Indexes } from './003-stage5-indexes.js'
import { migration004ArticleDetailStatus } from './004-article-detail-status.js'
import { migration005ArticleSimplify } from './005-article-simplify.js'
import type { AppliedMigration, Migration } from './types.js'

export type { AppliedMigration, Migration } from './types.js'

/**
 * 迁移清单。新增变更时在数组末尾追加，`id` 必须比现有全部迁移大。
 */
export const migrations: readonly Migration[] = [
  migration001InitialIndexes,
  migration002Stage3Upgrade,
  migration003Stage5Indexes,
  migration004ArticleDetailStatus,
  migration005ArticleSimplify,
]

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  ) STRICT
`

/** 读取已应用的迁移记录，按版本号升序。 */
export function getAppliedMigrations(db: Database): AppliedMigration[] {
  db.exec(CREATE_MIGRATIONS_TABLE)
  const rows = db.prepare('SELECT id, name, applied_at FROM _migrations ORDER BY id ASC').all() as unknown as Array<{
    id: number
    name: string
    applied_at: string
  }>
  return rows.map((row) => ({ id: row.id, name: row.name, appliedAt: row.applied_at }))
}

/**
 * 按版本号顺序执行尚未应用的迁移，返回本次新应用的记录。
 *
 * 每个迁移在独立事务中执行：迁移体与"已应用"标记同时提交，
 * 中途失败不会留下半应用状态，也未写入标记，下次启动会重试。
 */
export function runMigrations(
  db: Database,
  list: readonly Migration[] = migrations,
): AppliedMigration[] {
  const appliedIds = new Set(getAppliedMigrations(db).map((item) => item.id))
  const pending = [...list].sort((a, b) => a.id - b.id).filter((item) => !appliedIds.has(item.id))

  const insert = db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
  const applied: AppliedMigration[] = []

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db)
      const appliedAt = new Date().toISOString()
      insert.run(migration.id, migration.name, appliedAt)
      applied.push({ id: migration.id, name: migration.name, appliedAt })
    })
  }

  return applied
}
