import type { Database } from 'ormlet'
import type { Migration } from './types.js'

/**
 * 插件改为「单文件 + config + run」。
 *
 * 旧契约（`plugins/<name>/plugin.json` + 类式插件对象）不再兼容，因此：
 * 1. 补 `pluginId` 列（配置里的稳定 id，规则引用它）；
 * 2. 清空 plugin 表——旧记录没有 pluginId，也没有可复用的运行时代码，
 *    重新扫描插件目录即可重建；
 * 3. `pluginId` 建唯一索引，`name` 不再是唯一键（显示名允许重复）。
 *
 * 列本身由 ORMlet 模型同步，这里先判断再补，全新数据库执行是空操作。
 */
export const migration006SingleFilePlugins: Migration = {
  id: 6,
  name: 'single-file-plugins',
  up(db) {
    if (!hasColumn(db, 'plugin', 'pluginId')) {
      db.exec('ALTER TABLE plugin ADD COLUMN pluginId TEXT')
    }

    db.exec('DELETE FROM plugin')
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
