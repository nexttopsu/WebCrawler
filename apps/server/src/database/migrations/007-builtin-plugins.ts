import type { Database } from 'ormlet'
import type { Migration } from './types.js'

/**
 * 插件改为「内置 + 开关表」。
 *
 * 插件代码编在服务端里（`src/plugins`），名称、类型、版本、支持位置全部来自源码，
 * 数据库不再保存这些副本——只留一行「用户有没有关掉它」。
 *
 * 因此把 plugin 表里由文件扫描写入的列删掉。SQLite 的 DROP COLUMN 不支持删
 * 带索引或约束的列，`pluginId` 的唯一索引保留不动，其余列逐列判断后删除。
 */
export const migration007BuiltinPlugins: Migration = {
  id: 7,
  name: 'builtin-plugins',
  up(db) {
    // 旧契约遗留记录（没有 pluginId）无法对应任何内置插件，直接清掉
    db.exec('DELETE FROM plugin WHERE pluginId IS NULL OR pluginId = \'\'')

    for (const column of ['name', 'version', 'type', 'entry', 'description', 'config']) {
      if (hasColumn(db, 'plugin', column)) {
        db.exec(`ALTER TABLE plugin DROP COLUMN ${column}`)
      }
    }

    db.exec('DROP INDEX IF EXISTS ux_plugin_name')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_plugin_plugin_id ON plugin (pluginId)')
  },
}

/** 查询表的实际列名，用于判断旧列是否存在。 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ? LIMIT 1')
    .get(table, column)
  return row !== undefined
}
