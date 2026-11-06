import type { Database } from 'ormlet'
import type { Migration } from './types.js'

/**
 * 栏目支持多级：新增 `parentId`。
 *
 * `parentId` 为空表示顶级栏目，存量数据全部落在这一档，天然兼容原有的
 * 扁平结构。层级只用于组织与展示——父栏目本身也是可采集的真实栏目，
 * 「栏目 = 一个列表页 = 任务最小执行单元」这条约束没有变化。
 *
 * 建表时 ORMlet 会按模型自动补列，这里再判断一次，保证老库直接升级也能过；
 * 父栏目查询（找子栏目、判断能否删除）需要索引。
 */
export const migration008CategoryHierarchy: Migration = {
  id: 8,
  name: 'category-hierarchy',
  up(db) {
    if (!hasColumn(db, 'category', 'parentId')) {
      db.exec('ALTER TABLE category ADD COLUMN parentId INTEGER')
    }
    db.exec('CREATE INDEX IF NOT EXISTS ix_category_parent ON category (parentId)')
  },
}

/** 查询表的实际列名，用于判断旧列是否存在。 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ? LIMIT 1')
    .get(table, column)
  return row !== undefined
}
