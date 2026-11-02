import type { Database } from 'ormlet'
import type { FieldRule } from '@webcrawler/shared'
import type { Migration } from './types.js'

/**
 * 第三阶段的结构升级。
 *
 * 第一阶段的站点 / 栏目 / 规则模型是按「单表列」设计的，第三阶段改为
 * 「网站 + 栏目 + JSON 规则」：字段更名、规则内容收进 `config`、
 * 栏目用 `enabled` 取代 `status`。这里做的是**增量迁移**：
 *
 * 1. 先把旧列的数据搬到新列；
 * 2. 再把旧列删除（SQLite 的 DROP COLUMN 要求先删掉引用该列的索引）；
 * 3. 最后补齐新结构需要的索引。
 *
 * 所有步骤都先检查列是否存在，因此：
 * - 全新数据库（已按新模型建表）执行本迁移是空操作；
 * - 第一阶段 / 第二阶段的数据库执行一次即可升级到新结构。
 *
 * `crawl_rule` 的旧选择器列从未被任何接口写入过，但迁移仍会把它们
 * 尽力转换成一个合法的规则 JSON，避免理论上存在的历史数据丢失。
 */
export const migration002Stage3Upgrade: Migration = {
  id: 2,
  name: 'stage3-site-category-rule',
  up(db) {
    upgradeSite(db)
    upgradeCategory(db)
    upgradeRule(db)
    upgradeTask(db)
    ensureStage3Indexes(db)
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

function upgradeSite(db: Database): void {
  if (hasColumn(db, 'site', 'url')) {
    db.exec(`UPDATE site SET baseUrl = url WHERE baseUrl IS NULL AND url IS NOT NULL`)
  }
  if (hasColumn(db, 'site', 'remark')) {
    db.exec(`UPDATE site SET description = remark WHERE description IS NULL AND remark IS NOT NULL`)
  }
  // 旧数据只有域名时补一个可用的基址，业务层仍会校验 baseUrl 合法性
  db.exec(`
    UPDATE site
    SET baseUrl = 'https://' || domain
    WHERE baseUrl IS NULL AND domain IS NOT NULL AND domain NOT LIKE '%://%'
  `)
  db.exec(`UPDATE site SET status = 'active' WHERE status IS NULL`)

  dropColumn(db, 'site', 'url')
  dropColumn(db, 'site', 'remark')
}

function upgradeCategory(db: Database): void {
  if (hasColumn(db, 'category', 'url')) {
    db.exec(`UPDATE category SET listUrl = url WHERE listUrl IS NULL AND url IS NOT NULL`)
    // 唯一索引引用了 url，必须先删除才能删列
    db.exec(`DROP INDEX IF EXISTS ux_category_site_url`)
  }
  if (hasColumn(db, 'category', 'status')) {
    db.exec(`UPDATE category SET enabled = CASE WHEN status = 'active' THEN 1 ELSE 0 END WHERE enabled IS NULL`)
  }
  if (hasColumn(db, 'category', 'remark')) {
    db.exec(`UPDATE category SET description = remark WHERE description IS NULL AND remark IS NOT NULL`)
  }

  db.exec(`UPDATE category SET enabled = 1 WHERE enabled IS NULL`)
  db.exec(`UPDATE category SET crawlInterval = 0 WHERE crawlInterval IS NULL`)
  db.exec(`UPDATE category SET sortOrder = 0 WHERE sortOrder IS NULL`)

  // 父栏目与排序在第一阶段的模型中存在，但第三版不再使用层级
  db.exec(`DROP INDEX IF EXISTS ix_category_parent`)
  dropColumn(db, 'category', 'url')
  dropColumn(db, 'category', 'parentId')
  dropColumn(db, 'category', 'status')
  dropColumn(db, 'category', 'remark')
}

interface LegacyRuleRow {
  id: number
  listUrl: string | null
  itemSelector: string | null
  linkSelector: string | null
  titleSelector: string | null
  contentSelector: string | null
  authorSelector: string | null
  publishedAtSelector: string | null
  encoding: string | null
  requestHeaders: string | null
  pageLimit: number | null
}

/** 把第一阶段的列式规则转换成一个合法的规则 JSON；没有可用信息时返回 null。 */
function buildLegacyConfig(row: LegacyRuleRow): Record<string, unknown> | null {
  if (!row.itemSelector) return null

  const fields: Record<string, FieldRule> = {}
  const addField = (key: string, selector: string | null, type: FieldRule['type']): void => {
    if (!selector) return
    fields[key] = { type, selector }
  }
  addField('title', row.titleSelector, 'text')
  addField('content', row.contentSelector, 'html')
  addField('author', row.authorSelector, 'text')
  addField('publishTime', row.publishedAtSelector, 'text')

  const config: Record<string, unknown> = {
    version: 1,
    list: {
      itemSelector: row.itemSelector,
      ...(row.listUrl ? { url: row.listUrl } : {}),
      ...(row.linkSelector ? { linkSelector: row.linkSelector } : {}),
      ...(row.titleSelector ? { titleSelector: row.titleSelector } : {}),
    },
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  }

  const request: Record<string, unknown> = {}
  if (row.encoding) request.encoding = row.encoding
  if (row.requestHeaders) {
    try {
      const parsed: unknown = JSON.parse(row.requestHeaders)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        request.headers = parsed
      }
    } catch {
      // 旧数据不是合法 JSON，直接忽略，不让迁移失败
    }
  }
  if (Object.keys(request).length > 0) config.request = request

  if (typeof row.pageLimit === 'number' && row.pageLimit > 1) {
    config.pagination = { type: 'none', maxPages: Math.min(row.pageLimit, 100) }
  }

  return config
}

function upgradeRule(db: Database): void {
  const hasLegacySelectors =
    hasColumn(db, 'crawl_rule', 'itemSelector') || hasColumn(db, 'crawl_rule', 'contentSelector')

  if (hasLegacySelectors) {
    const rows = db
      .prepare(
        `SELECT id, listUrl, itemSelector, linkSelector, titleSelector, contentSelector,
                authorSelector, publishedAtSelector, encoding, requestHeaders, pageLimit
         FROM crawl_rule
         WHERE config IS NULL`,
      )
      .all() as unknown as LegacyRuleRow[]

    const update = db.prepare('UPDATE crawl_rule SET config = ?, version = 1 WHERE id = ?')
    for (const row of rows) {
      const config = buildLegacyConfig(row)
      if (config) update.run(JSON.stringify(config), row.id)
    }
  }

  db.exec(`UPDATE crawl_rule SET version = 1 WHERE version IS NULL`)
  db.exec(`UPDATE crawl_rule SET status = 'enabled' WHERE status IS NULL`)

  // 旧规则没有版本历史：把当前配置补成 v1，保证「每条规则都有版本记录」
  const rules = db
    .prepare('SELECT id, version, config FROM crawl_rule WHERE config IS NOT NULL')
    .all() as unknown as Array<{ id: number; version: number | null; config: string }>
  const hasVersion = db.prepare('SELECT 1 AS ok FROM crawl_rule_version WHERE ruleId = ? AND version = ? LIMIT 1')
  const insertVersion = db.prepare(
    `INSERT INTO crawl_rule_version (ruleId, version, config, note, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  for (const row of rules) {
    const version = row.version ?? 1
    if (hasVersion.get(row.id, version) !== undefined) continue
    insertVersion.run(row.id, version, row.config, '结构升级时导入', now, now)
  }

  for (const column of [
    'listUrl',
    'listSelector',
    'itemSelector',
    'titleSelector',
    'linkSelector',
    'contentSelector',
    'authorSelector',
    'publishedAtSelector',
    'encoding',
    'requestHeaders',
    'pageLimit',
    'remark',
  ]) {
    dropColumn(db, 'crawl_rule', column)
  }
}

function upgradeTask(db: Database): void {
  // 旧任务没有规则快照：至少回填当时的规则修订号，便于追溯
  db.exec(`
    UPDATE crawl_task
    SET ruleVersion = (
      SELECT version FROM crawl_rule WHERE crawl_rule.id = crawl_task.ruleId
    )
    WHERE ruleVersion IS NULL AND ruleId IS NOT NULL
  `)
}

/** 旧版 001 没有这些索引，升级库需要补齐；新建库重复执行是无害的。 */
function ensureStage3Indexes(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_site_status ON site (status);
    CREATE INDEX IF NOT EXISTS ix_site_default_rule ON site (defaultRuleId);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_category_site_list_url ON category (siteId, listUrl);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_category_site_code ON category (siteId, code);
    CREATE INDEX IF NOT EXISTS ix_category_site ON category (siteId);
    CREATE INDEX IF NOT EXISTS ix_category_rule ON category (ruleId);
    CREATE INDEX IF NOT EXISTS ix_category_proxy ON category (proxyId);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_crawl_rule_site_name ON crawl_rule (siteId, name);
    CREATE INDEX IF NOT EXISTS ix_crawl_rule_site ON crawl_rule (siteId);
    CREATE INDEX IF NOT EXISTS ix_crawl_rule_category ON crawl_rule (categoryId);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_crawl_rule_version ON crawl_rule_version (ruleId, version);
    CREATE INDEX IF NOT EXISTS ix_crawl_rule_version_rule ON crawl_rule_version (ruleId);

    CREATE INDEX IF NOT EXISTS ix_crawl_task_category ON crawl_task (categoryId);
    CREATE INDEX IF NOT EXISTS ix_crawl_error_site ON crawl_error (siteId);
  `)
}
