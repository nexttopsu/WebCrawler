import type { Database } from 'ormlet'
import type { Migration } from './types.js'

/**
 * 文章字段精简。
 *
 * 数据模型去掉：发布状态(status)、发布时间(publishedAt)、采集时间(crawlTime)、
 * contentHtml、contentHash、wordCount、detailCollectedAt、detailError、images；
 * 新增「文章时间」(articleTime)：采集数据时标注的原站点发布时间，
 * 存量数据直接从 publishedAt 搬运。
 *
 * 列本身由 ORMlet 模型同步，本迁移负责：
 * 1. 删除引用被删列的旧索引（SQLite 的 DROP COLUMN 要求先删索引）；
 * 2. 把 publishedAt 的存量值搬到 articleTime；
 * 3. 删除不再使用的列；
 * 4. 补 articleTime 查询索引。
 *
 * 所有步骤先检查列/索引是否存在，因此全新数据库执行本迁移是空操作。
 */
export const migration005ArticleSimplify: Migration = {
  id: 5,
  name: 'article-simplify',
  up(db) {
    dropLegacyIndexes(db)

    if (hasColumn(db, 'article', 'publishedAt')) {
      db.exec('UPDATE article SET articleTime = publishedAt WHERE articleTime IS NULL AND publishedAt IS NOT NULL')
    }

    for (const column of [
      'status',
      'publishedAt',
      'crawlTime',
      'contentHtml',
      'contentHash',
      'wordCount',
      'detailCollectedAt',
      'detailError',
      'images',
    ]) {
      dropColumn(db, 'article', column)
    }

    db.exec('CREATE INDEX IF NOT EXISTS ix_article_article_time ON article (articleTime)')
  },
}

/** 查询表的实际列名，用于判断旧列是否存在。 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ? LIMIT 1')
    .get(table, column)
  return row !== undefined
}

/** 删除列（存在才删）。表名与列名均来自本文件的常量，不拼接外部输入。 */
function dropColumn(db: Database, table: string, column: string): void {
  if (!hasColumn(db, table, column)) return
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

/** 引用了被删列的旧索引，删列前必须先删掉。 */
function dropLegacyIndexes(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS ix_article_status;
    DROP INDEX IF EXISTS ix_article_published_at;
    DROP INDEX IF EXISTS ix_article_content_hash;
    DROP INDEX IF EXISTS ix_article_crawl_time;
    DROP INDEX IF EXISTS ix_article_site_published;
  `)
}
