import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UniqueConstraintError } from 'ormlet'
import {
  closeDatabase,
  getModels,
  initDatabase,
  runMigrations,
  type DatabaseContext,
} from '../../src/database/index.js'

let context: DatabaseContext

beforeAll(() => {
  context = initDatabase({ file: ':memory:' })
})

afterAll(() => {
  closeDatabase()
})

describe('数据库初始化', () => {
  it('注册全部 12 个模型并自动建表', () => {
    const models = getModels()
    expect(Object.keys(models)).toHaveLength(12)
    expect(Object.keys(models).sort()).toEqual([
      'article',
      'category',
      'crawlError',
      'crawlLog',
      'crawlRule',
      'crawlRuleVersion',
      'crawlSchedule',
      'crawlTask',
      'plugin',
      'proxy',
      'site',
      'systemSetting',
    ])
  })

  it('执行基线迁移并记录版本', () => {
    expect(context.migrations.map((item) => item.id)).toEqual([1, 2, 3, 4])
    expect(context.migrations.map((item) => item.name)).toEqual([
      'initial-indexes',
      'stage3-site-category-rule',
      'stage5-task-schedule-indexes',
      'article-detail-status',
    ])
  })

  it('重复执行迁移不会重复应用', () => {
    expect(runMigrations(context.db)).toEqual([])
  })

  it('唯一索引已建立', () => {
    const rows = context.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ux_%' ORDER BY name`)
      .all() as unknown as Array<{ name: string }>
    const names = rows.map((row) => row.name)

    expect(names).toContain('ux_site_domain')
    expect(names).toContain('ux_category_site_list_url')
    expect(names).toContain('ux_category_site_code')
    expect(names).toContain('ux_crawl_rule_site_name')
    expect(names).toContain('ux_crawl_rule_version')
    expect(names).toContain('ux_article_url')
    expect(names).toContain('ux_proxy_endpoint')
    expect(names).toContain('ux_system_setting_key')
  })
})

describe('模型读写', () => {
  it('创建、查询、更新、删除站点', () => {
    const { site } = getModels()

    const created = site.create({
      name: '示例站点',
      domain: 'example.com',
      baseUrl: 'https://example.com',
      status: 'active',
    })
    expect(created.id).toBeGreaterThan(0)
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(created.status).toBe('active')

    const found = site.findById(created.id)
    expect(found?.name).toBe('示例站点')

    const updated = site.update(created.id, { description: '备注' })
    expect(updated?.description).toBe('备注')
    expect(updated?.updatedAt).not.toBeNull()

    const removed = site.delete(created.id)
    expect(removed?.id).toBe(created.id)
    expect(site.findById(created.id)).toBeUndefined()
  })

  it('域名唯一索引拦截重复站点', () => {
    const { site } = getModels()
    site.create({ name: '站点 A', domain: 'dup.com', baseUrl: 'https://dup.com', status: 'active' })

    expect(() =>
      site.create({ name: '站点 B', domain: 'dup.com', baseUrl: 'https://dup.com/2', status: 'active' }),
    ).toThrow(UniqueConstraintError)
  })

  it('栏目按站点与启用状态查询', () => {
    const { site, category } = getModels()
    const siteRow = site.create({
      name: '栏目测试站',
      domain: 'cat.example.com',
      baseUrl: 'https://cat.example.com',
      status: 'active',
    })

    category.createMany([
      {
        siteId: siteRow.id,
        name: '新闻',
        code: 'news',
        listUrl: 'https://cat.example.com/news',
        enabled: 1,
        crawlInterval: 1800,
      },
      {
        siteId: siteRow.id,
        name: '公告',
        code: 'notice',
        listUrl: 'https://cat.example.com/notice',
        enabled: 0,
        crawlInterval: 0,
      },
    ])

    expect(category.count({ siteId: siteRow.id })).toBe(2)
    expect(category.count({ siteId: siteRow.id, enabled: 1 })).toBe(1)
    expect(category.findOne({ code: 'news' })?.name).toBe('新闻')
  })

  it('同一站点下的栏目编号唯一', () => {
    const { site, category } = getModels()
    const siteRow = site.create({
      name: '编号唯一站',
      domain: 'code.example.com',
      baseUrl: 'https://code.example.com',
      status: 'active',
    })

    category.create({
      siteId: siteRow.id,
      name: '栏目一',
      code: 'dup',
      listUrl: 'https://code.example.com/a',
      enabled: 1,
    })

    expect(() =>
      category.create({
        siteId: siteRow.id,
        name: '栏目二',
        code: 'dup',
        listUrl: 'https://code.example.com/b',
        enabled: 1,
      }),
    ).toThrow(UniqueConstraintError)
  })

  it('规则与版本记录按（ruleId, version）唯一', () => {
    const { site, crawlRule, crawlRuleVersion } = getModels()
    const siteRow = site.create({
      name: '规则站',
      domain: 'rule.example.com',
      baseUrl: 'https://rule.example.com',
      status: 'active',
    })

    const rule = crawlRule.create({
      siteId: siteRow.id,
      name: '默认规则',
      config: JSON.stringify({ version: 1 }),
      version: 1,
      status: 'enabled',
    })

    crawlRuleVersion.create({
      ruleId: rule.id,
      version: 1,
      config: JSON.stringify({ version: 1 }),
      note: '创建',
    })

    expect(() =>
      crawlRuleVersion.create({
        ruleId: rule.id,
        version: 1,
        config: JSON.stringify({ version: 1 }),
        note: '重复版本',
      }),
    ).toThrow(UniqueConstraintError)

    expect(crawlRuleVersion.count({ ruleId: rule.id })).toBe(1)
  })

  it('文章按站点与发布时间查询', () => {
    const { article } = getModels()

    article.createMany([
      {
        siteId: 1,
        categoryId: 1,
        taskId: 1,
        title: '第一篇',
        url: 'https://example.com/a/1',
        publishedAt: '2026-01-01T08:00:00.000Z',
        status: 'published',
      },
      {
        siteId: 1,
        categoryId: 1,
        taskId: 1,
        title: '第二篇',
        url: 'https://example.com/a/2',
        publishedAt: '2026-01-02T08:00:00.000Z',
        status: 'pending',
      },
    ])

    const latest = article.findMany(
      { siteId: 1 },
      { orderBy: 'publishedAt', order: 'DESC', limit: 1 },
    )
    expect(latest).toHaveLength(1)
    expect(latest[0]?.title).toBe('第二篇')

    expect(article.count({ siteId: 1 })).toBe(2)
    expect(article.count({ siteId: 1, status: 'pending' })).toBe(1)
  })

  it('系统设置按键 upsert', () => {
    const { systemSetting } = getModels()

    systemSetting.upsert(
      { settingKey: 'site.name', settingValue: 'WebCrawler', description: '站点名称', groupName: 'basic' },
      { on: ['settingKey'] },
    )
    const updated = systemSetting.upsert(
      { settingKey: 'site.name', settingValue: 'WebCrawler 采集平台', description: '站点名称', groupName: 'basic' },
      { on: ['settingKey'] },
    )

    expect(updated.settingValue).toBe('WebCrawler 采集平台')
    expect(systemSetting.count()).toBe(1)
    expect(systemSetting.findOne({ settingKey: 'site.name' })?.settingValue).toBe('WebCrawler 采集平台')
  })

  it('事务失败时回滚', () => {
    const { category } = getModels()
    const before = category.count()

    expect(() =>
      context.db.transaction(() => {
        category.create({ siteId: 99, name: '临时栏目', listUrl: 'https://example.com/c/1', enabled: 1 })
        throw new Error('模拟失败')
      }),
    ).toThrow('模拟失败')

    expect(category.count()).toBe(before)
  })
})
