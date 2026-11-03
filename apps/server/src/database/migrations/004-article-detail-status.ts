import type { Migration } from './types.js'

/**
 * 列表 / 详情分离采集：文章表补详情状态列并回填存量数据。
 *
 * 列本身由 ORMlet 模型同步创建，迁移只负责：
 * 1. 按有无正文回填 detailStatus（有正文视为详情已采集）；
 * 2. 补详情状态筛选索引。
 * 全部语句幂等，异常重跑安全。
 */
export const migration004ArticleDetailStatus: Migration = {
  id: 4,
  name: 'article-detail-status',
  up(db) {
    // 存量文章都是「列表 + 详情」一条龙采出来的：有正文即详情已完成
    db.exec(`
      UPDATE article SET detailStatus = 'collected'
      WHERE detailStatus IS NULL AND content IS NOT NULL AND content != '';

      UPDATE article SET detailStatus = 'pending'
      WHERE detailStatus IS NULL;

      CREATE INDEX IF NOT EXISTS ix_article_detail_status ON article (siteId, categoryId, detailStatus);
    `)
  },
}
