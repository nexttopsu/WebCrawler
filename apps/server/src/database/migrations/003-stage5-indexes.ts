import type { Migration } from './types.js'

/**
 * 第五阶段：任务调度、增量去重与日志所需的索引。
 *
 * 表与列由 ORMlet 的模型定义负责创建/补列，迁移只补索引。
 * 全部语句幂等，异常重跑安全。
 */
export const migration003Stage5Indexes: Migration = {
  id: 3,
  name: 'stage5-task-schedule-indexes',
  up(db) {
    db.exec(`
      -- 任务：按站点/状态、定时来源、创建时间查询
      CREATE INDEX IF NOT EXISTS ix_crawl_task_site_status ON crawl_task (siteId, status);
      CREATE INDEX IF NOT EXISTS ix_crawl_task_status_created ON crawl_task (status, createdAt);
      CREATE INDEX IF NOT EXISTS ix_crawl_task_schedule ON crawl_task (scheduleId);
      CREATE INDEX IF NOT EXISTS ix_crawl_task_schedule_status ON crawl_task (scheduleId, status);

      -- 文章：列表筛选
      CREATE INDEX IF NOT EXISTS ix_article_site_category ON article (siteId, categoryId);

      -- 代理：类型与启用状态筛选
      CREATE INDEX IF NOT EXISTS ix_proxy_protocol ON proxy (protocol);
      CREATE INDEX IF NOT EXISTS ix_proxy_enabled ON proxy (enabled);

      -- 定时任务：名称唯一，启用的任务按下次执行时间扫描
      CREATE UNIQUE INDEX IF NOT EXISTS ux_crawl_schedule_name ON crawl_schedule (name);
      CREATE INDEX IF NOT EXISTS ix_crawl_schedule_site ON crawl_schedule (siteId);
      CREATE INDEX IF NOT EXISTS ix_crawl_schedule_enabled ON crawl_schedule (enabled, nextRunAt);

      -- 日志：按任务、级别、时间排查
      CREATE INDEX IF NOT EXISTS ix_crawl_log_task ON crawl_log (taskId);
      CREATE INDEX IF NOT EXISTS ix_crawl_log_site ON crawl_log (siteId);
      CREATE INDEX IF NOT EXISTS ix_crawl_log_level ON crawl_log (level);
      CREATE INDEX IF NOT EXISTS ix_crawl_log_created ON crawl_log (createdAt);
    `)
  },
}
