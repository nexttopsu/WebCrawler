import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { createCategory, createSite, startTestApp, stopTestApp } from './helpers/app.js'
import {
  applyArticleDetail,
  listArticlesForDetailCollect,
  markArticleDetailFailed,
  saveListArticle,
} from '../../src/server/services/article-service.js'
import { getModels } from '../../src/database/index.js'
import type { ArticleData } from '../../src/shared/index.js'

function detail(url: string, overrides: Partial<ArticleData> = {}): ArticleData {
  return {
    siteId: '1',
    categoryId: '1',
    title: '详情标题',
    url,
    content: '详情正文，内容足够长。',
    html: '<p>详情正文</p>',
    images: ['https://example.com/images/detail.png'],
    crawlTime: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('列表 / 详情分离采集', () => {
  let app: H3
  let site: any
  let category: any

  beforeAll(async () => {
    app = startTestApp()
    site = await createSite(app, { name: '分离采集站点', domain: 'example.com' })
    category = await createCategory(app, {
      siteId: site.id,
      name: '新闻',
      listUrl: 'https://example.com/news',
    })
  })

  afterAll(() => stopTestApp())

  it('列表阶段入库：detailStatus = pending，自定义字段进 extra', () => {
    const outcome = saveListArticle({
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
      title: '列表标题 A',
      url: 'https://example.com/article/a',
      coverUrl: 'https://example.com/cover/a.png',
      extra: { listTag: '置顶' },
    })

    expect(outcome.status).toBe('created')
    const row = getModels().article.findOne({ url: 'https://example.com/article/a' })
    expect(row?.detailStatus).toBe('pending')
    expect(row?.title).toBe('列表标题 A')
    expect(JSON.parse(row?.extra ?? '{}')).toMatchObject({ listTag: '置顶' })
  })

  it('重复列表入库被跳过，不覆盖已有数据', () => {
    const outcome = saveListArticle({
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
      title: '另一个标题',
      url: 'https://example.com/article/a',
    })
    expect(outcome.status).toBe('skipped')
    expect(getModels().article.findOne({ url: 'https://example.com/article/a' })?.title).toBe('列表标题 A')
  })

  it('详情补采：同名字段有值才覆盖，空值保留列表阶段的值', () => {
    saveListArticle({
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
      title: '列表标题 B',
      url: 'https://example.com/article/b',
      extra: { listTag: '置顶' },
    })

    const outcome = applyArticleDetail({
      article: detail('https://example.com/article/b', {
        title: '', // 空标题：保留列表标题
        author: '详情作者',
        metadata: { listTag: '详情覆盖', fromDetail: 'yes' },
      }),
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
    })

    expect(outcome.status).toBe('updated')
    const row = getModels().article.findOne({ url: 'https://example.com/article/b' })
    expect(row?.title).toBe('列表标题 B')
    expect(row?.author).toBe('详情作者')
    expect(row?.detailStatus).toBe('collected')
    expect(row?.detailCollectedAt).not.toBeNull()
    expect(JSON.parse(row?.extra ?? '{}')).toMatchObject({ listTag: '详情覆盖', fromDetail: 'yes' })
  })

  it('详情内容未变化时 skipped，详情状态仍置为已采集', () => {
    applyArticleDetail({
      article: detail('https://example.com/article/c'),
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
    })
    // 首条详情是直接创建的（无历史 Hash），第二次补齐 Hash，第三次命中「未变化」
    applyArticleDetail({
      article: detail('https://example.com/article/c'),
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
    })
    const outcome = applyArticleDetail({
      article: detail('https://example.com/article/c'),
      siteId: site.id,
      categoryId: category.id,
      taskId: null,
    })

    expect(outcome.status).toBe('skipped')
    const row = getModels().article.findOne({ url: 'https://example.com/article/c' })
    expect(row?.detailStatus).toBe('collected')
  })

  it('失败标记与待补采查询', () => {
    markArticleDetailFailed('https://example.com/article/a', 'HTTP 500')
    const row = getModels().article.findOne({ url: 'https://example.com/article/a' })
    expect(row?.detailStatus).toBe('failed')
    expect(row?.detailError).toContain('HTTP 500')

    const pending = listArticlesForDetailCollect({ siteId: site.id, categoryId: category.id, limit: 100 })
    const urls = pending.map((item) => item.url)
    expect(urls).toContain('https://example.com/article/a')
    expect(urls).not.toContain('https://example.com/article/b')

    const excluded = listArticlesForDetailCollect({
      siteId: site.id,
      categoryId: category.id,
      excludeUrls: new Set(urls),
      limit: 100,
    })
    expect(excluded.find((item) => item.url === 'https://example.com/article/a')).toBeUndefined()
  })
})
