import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { closeDatabase, initDatabase } from '../../src/database/index.js'

/**
 * 第一阶段数据库升级测试。
 *
 * 手工构造一阶段的表结构与数据（含已应用的 001 迁移记录），
 * 再用当前代码初始化，验证 002 能把旧结构升级到第三阶段：
 * 字段改名、规则 JSON 转换、索引重建，且数据不丢。
 */

function createLegacyDatabase(file: string): void {
  const db = new DatabaseSync(file)

  db.exec(`
    CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO _migrations (id, name, applied_at)
    VALUES (1, 'initial-indexes', '2026-01-01T00:00:00.000Z');

    CREATE TABLE site (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT,
      updatedAt TEXT,
      name TEXT,
      domain TEXT,
      url TEXT,
      status TEXT,
      remark TEXT
    ) STRICT;
    CREATE UNIQUE INDEX ux_site_domain ON site (domain);

    CREATE TABLE category (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT,
      updatedAt TEXT,
      siteId INTEGER,
      parentId INTEGER,
      name TEXT,
      url TEXT,
      status TEXT,
      sortOrder INTEGER,
      remark TEXT
    ) STRICT;
    CREATE UNIQUE INDEX ux_category_site_url ON category (siteId, url);
    CREATE INDEX ix_category_parent ON category (parentId);

    CREATE TABLE crawl_rule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT,
      updatedAt TEXT,
      siteId INTEGER,
      categoryId INTEGER,
      name TEXT,
      status TEXT,
      listUrl TEXT,
      listSelector TEXT,
      itemSelector TEXT,
      titleSelector TEXT,
      linkSelector TEXT,
      contentSelector TEXT,
      authorSelector TEXT,
      publishedAtSelector TEXT,
      encoding TEXT,
      requestHeaders TEXT,
      pageLimit INTEGER,
      remark TEXT
    ) STRICT;
    CREATE UNIQUE INDEX ux_crawl_rule_site_name ON crawl_rule (siteId, name);

    CREATE TABLE crawl_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT,
      updatedAt TEXT,
      siteId INTEGER,
      categoryId INTEGER,
      ruleId INTEGER,
      name TEXT,
      status TEXT,
      cron TEXT,
      lastRunAt TEXT,
      nextRunAt TEXT,
      totalCount INTEGER,
      successCount INTEGER,
      failCount INTEGER,
      message TEXT
    ) STRICT;
    CREATE INDEX ix_crawl_task_rule ON crawl_task (ruleId);

    INSERT INTO site (createdAt, updatedAt, name, domain, url, status, remark)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '旧站点', 'old.example.com',
            'https://old.example.com', 'active', '旧备注');

    INSERT INTO category (createdAt, updatedAt, siteId, parentId, name, url, status, sortOrder, remark)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, NULL, '新闻中心',
            'https://old.example.com/news', 'active', 1, '栏目备注');

    INSERT INTO crawl_rule (
      createdAt, updatedAt, siteId, categoryId, name, status, listUrl, itemSelector,
      titleSelector, linkSelector, contentSelector, authorSelector, publishedAtSelector,
      encoding, requestHeaders, pageLimit, remark
    ) VALUES (
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, NULL, '旧规则', 'enabled',
      'https://old.example.com/news', '.news-item', 'h1', 'a', '.content', '.author', '.time',
      'gbk', '{"referer":"https://old.example.com"}', 5, '规则备注'
    );

    INSERT INTO crawl_task (createdAt, updatedAt, siteId, categoryId, ruleId, name, status)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 1, 1, '旧任务', 'pending');
  `)

  db.close()
}

function columnsOf(file: string, table: string): string[] {
  const db = new DatabaseSync(file)
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).all(table) as unknown as Array<{
    name: string
  }>
  db.close()
  return rows.map((row) => row.name)
}

describe('第一阶段数据库升级', () => {
  it('保留数据并转换到第三阶段结构', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-migration-'))
    const file = join(dir, 'legacy.db')

    try {
      createLegacyDatabase(file)

      const context = initDatabase({ file })
      try {
        expect(context.migrations.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

        // 站点：url → baseUrl，remark → description，旧列被删除
        const siteColumns = columnsOf(file, 'site')
        expect(siteColumns).toContain('baseUrl')
        expect(siteColumns).not.toContain('url')
        expect(siteColumns).not.toContain('remark')

        const site = context.models.site.findById(1)
        expect(site?.baseUrl).toBe('https://old.example.com')
        expect(site?.description).toBe('旧备注')
        expect(site?.status).toBe('active')

        // 栏目：url → listUrl，status → enabled
        const categoryColumns = columnsOf(file, 'category')
        expect(categoryColumns).toContain('listUrl')
        expect(categoryColumns).not.toContain('url')
        expect(categoryColumns).toContain('parentId')
        expect(categoryColumns).not.toContain('status')

        const category = context.models.category.findById(1)
        expect(category?.listUrl).toBe('https://old.example.com/news')
        expect(category?.enabled).toBe(1)
        expect(category?.description).toBe('栏目备注')
        expect(category?.crawlInterval).toBe(0)

        // 规则：选择器列转换为 config JSON
        const ruleColumns = columnsOf(file, 'crawl_rule')
        expect(ruleColumns).toContain('config')
        expect(ruleColumns).not.toContain('itemSelector')
        expect(ruleColumns).not.toContain('contentSelector')

        const rule = context.models.crawlRule.findById(1)
        const config = JSON.parse(rule?.config ?? '{}') as {
          version: number
          list: { itemSelector: string; url?: string }
          fields: Record<string, { selector?: string; type?: string }>
          request?: { encoding?: string; headers?: Record<string, string> }
          pagination?: { maxPages?: number }
        }
        expect(config.version).toBe(1)
        expect(config.list.itemSelector).toBe('.news-item')
        expect(config.list.url).toBe('https://old.example.com/news')
        expect(config.fields.title?.selector).toBe('h1')
        expect(config.fields.content?.type).toBe('html')
        expect(config.request?.encoding).toBe('gbk')
        expect(config.request?.headers?.referer).toBe('https://old.example.com')
        // 旧版「最多 n 页」已移除：迁移不再写入 pagination
        expect(config.pagination).toBeUndefined()
        expect(rule?.version).toBe(1)

        // 规则版本：为转换后的配置补一条版本记录
        const versions = context.models.crawlRuleVersion.findMany({ ruleId: 1 })
        expect(versions).toHaveLength(1)
        expect(versions[0]?.version).toBe(1)

        // 任务：回填规则修订号
        const task = context.models.crawlTask.findById(1)
        expect(task?.ruleVersion).toBe(1)

        // 新索引已建立
        const indexes = context.db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%category_site%' ORDER BY name`)
          .all() as unknown as Array<{ name: string }>
        expect(indexes.map((row) => row.name)).toContain('ux_category_site_list_url')
      } finally {
        closeDatabase()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全新数据库执行升级迁移是空操作', () => {
    const context = initDatabase({ file: ':memory:' })
    try {
      expect(context.migrations.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(context.models.site.count()).toBe(0)
      // 全新建表后不应残留旧列
      const columns = context.db
        .prepare(`SELECT name FROM pragma_table_info('site')`)
        .all() as unknown as Array<{ name: string }>
      expect(columns.map((row) => row.name)).not.toContain('url')
    } finally {
      closeDatabase()
    }
  })
})
