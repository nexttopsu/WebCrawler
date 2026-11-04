import type { Migration } from './types.js'

/**
 * 基线迁移：为「当前模型定义」建立唯一索引与查询索引。
 *
 * 表结构由 ORMlet 的 `db.model()` 负责创建（含自增主键与时间戳列），
 * 迁移只补充 ORMlet 未覆盖的部分——索引与后续的版本化变更。
 *
 * 全部语句使用 `IF NOT EXISTS`，因此重复执行是安全的。
 *
 * 说明：本项目尚未发布，`001` 随模型演进同步更新，保证全新安装拿到的是
 * 完整的新结构；已经应用过旧版 `001` 的数据库由 `002` 做增量升级。
 * 从 `003` 起不再修改历史迁移，只在末尾追加。
 *
 * 注意：SQLite 的唯一索引不约束 NULL，多行同为 NULL 不会冲突；
 * 必填性由业务层在写入前校验（ORMlet 的模型定义不支持 NOT NULL）。
 */
export const migration001InitialIndexes: Migration = {
  id: 1,
  name: 'initial-indexes',
  up(db) {
    db.exec(`
      -- 站点：域名唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_site_domain ON site (domain);
      CREATE INDEX IF NOT EXISTS ix_site_status ON site (status);
      CREATE INDEX IF NOT EXISTS ix_site_default_rule ON site (defaultRuleId);

      -- 栏目：同一站点下的列表地址、编码唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_category_site_list_url ON category (siteId, listUrl);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_category_site_code ON category (siteId, code);
      CREATE INDEX IF NOT EXISTS ix_category_site ON category (siteId);
      CREATE INDEX IF NOT EXISTS ix_category_rule ON category (ruleId);
      CREATE INDEX IF NOT EXISTS ix_category_proxy ON category (proxyId);

      -- 规则：同一站点下的规则名唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_crawl_rule_site_name ON crawl_rule (siteId, name);
      CREATE INDEX IF NOT EXISTS ix_crawl_rule_site ON crawl_rule (siteId);
      CREATE INDEX IF NOT EXISTS ix_crawl_rule_category ON crawl_rule (categoryId);

      -- 规则版本：同一规则的修订号唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_crawl_rule_version ON crawl_rule_version (ruleId, version);
      CREATE INDEX IF NOT EXISTS ix_crawl_rule_version_rule ON crawl_rule_version (ruleId);

      -- 任务：按站点、栏目、规则、状态查询
      CREATE INDEX IF NOT EXISTS ix_crawl_task_site ON crawl_task (siteId);
      CREATE INDEX IF NOT EXISTS ix_crawl_task_category ON crawl_task (categoryId);
      CREATE INDEX IF NOT EXISTS ix_crawl_task_rule ON crawl_task (ruleId);
      CREATE INDEX IF NOT EXISTS ix_crawl_task_status ON crawl_task (status);

      -- 文章：URL 唯一，列表页按文章时间倒序
      CREATE UNIQUE INDEX IF NOT EXISTS ux_article_url ON article (url);
      CREATE INDEX IF NOT EXISTS ix_article_site ON article (siteId);
      CREATE INDEX IF NOT EXISTS ix_article_category ON article (categoryId);
      CREATE INDEX IF NOT EXISTS ix_article_task ON article (taskId);
      CREATE INDEX IF NOT EXISTS ix_article_article_time ON article (articleTime);

      -- 代理：协议 + 主机 + 端口唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_proxy_endpoint ON proxy (protocol, host, port);
      CREATE INDEX IF NOT EXISTS ix_proxy_status ON proxy (status);

      -- 插件：名称唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_plugin_name ON plugin (name);

      -- 采集错误：按任务与时间排查
      CREATE INDEX IF NOT EXISTS ix_crawl_error_task ON crawl_error (taskId);
      CREATE INDEX IF NOT EXISTS ix_crawl_error_site ON crawl_error (siteId);
      CREATE INDEX IF NOT EXISTS ix_crawl_error_occurred_at ON crawl_error (occurredAt);

      -- 系统设置：键唯一
      CREATE UNIQUE INDEX IF NOT EXISTS ux_system_setting_key ON system_setting (settingKey);
    `)
  },
}
