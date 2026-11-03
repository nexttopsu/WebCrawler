import type { Database } from 'ormlet'
import {
  ARTICLE_TABLE,
  CATEGORY_TABLE,
  CRAWL_ERROR_TABLE,
  CRAWL_LOG_TABLE,
  CRAWL_RULE_TABLE,
  CRAWL_RULE_VERSION_TABLE,
  CRAWL_SCHEDULE_TABLE,
  CRAWL_TASK_TABLE,
  PLUGIN_TABLE,
  PROXY_TABLE,
  SITE_TABLE,
  SYSTEM_SETTING_TABLE,
  articleFields,
  categoryFields,
  crawlErrorFields,
  crawlLogFields,
  crawlRuleFields,
  crawlRuleVersionFields,
  crawlScheduleFields,
  crawlTaskFields,
  pluginFields,
  proxyFields,
  siteFields,
  systemSettingFields,
} from './fields.js'

/**
 * 在一个数据库连接上注册全部模型。
 *
 * `db.model()` 是幂等的：同名同定义重复调用会返回同一个实例，
 * 表不存在时自动建表，模型新增字段时自动补列。
 * 所有模型共享 `db` 持有的唯一连接，业务模块不得自行 `new Database()`。
 */
export function defineModels(db: Database) {
  return {
    site: db.model('Site', { tableName: SITE_TABLE, fields: siteFields }),
    category: db.model('Category', { tableName: CATEGORY_TABLE, fields: categoryFields }),
    crawlRule: db.model('CrawlRule', { tableName: CRAWL_RULE_TABLE, fields: crawlRuleFields }),
    crawlRuleVersion: db.model('CrawlRuleVersion', {
      tableName: CRAWL_RULE_VERSION_TABLE,
      fields: crawlRuleVersionFields,
    }),
    crawlTask: db.model('CrawlTask', { tableName: CRAWL_TASK_TABLE, fields: crawlTaskFields }),
    crawlSchedule: db.model('CrawlSchedule', {
      tableName: CRAWL_SCHEDULE_TABLE,
      fields: crawlScheduleFields,
    }),
    crawlLog: db.model('CrawlLog', { tableName: CRAWL_LOG_TABLE, fields: crawlLogFields }),
    article: db.model('Article', { tableName: ARTICLE_TABLE, fields: articleFields }),
    proxy: db.model('Proxy', { tableName: PROXY_TABLE, fields: proxyFields }),
    plugin: db.model('Plugin', { tableName: PLUGIN_TABLE, fields: pluginFields }),
    crawlError: db.model('CrawlError', { tableName: CRAWL_ERROR_TABLE, fields: crawlErrorFields }),
    systemSetting: db.model('SystemSetting', {
      tableName: SYSTEM_SETTING_TABLE,
      fields: systemSettingFields,
    }),
  }
}

/** 全部模型的集合类型。 */
export type DatabaseModels = ReturnType<typeof defineModels>

/** 模型在集合中的键名，例如 `'site' | 'article'`。 */
export type DatabaseModelName = keyof DatabaseModels
