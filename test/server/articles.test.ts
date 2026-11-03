import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import {
  call,
  createCategory,
  createSite,
  json,
  startTestApp,
  stopTestApp,
} from './helpers/app.js'
import { saveCrawledArticle } from '../../src/server/services/article-service.js'
import { getModels } from '../../src/database/index.js'
import type { ArticleData } from '../../src/shared/index.js'

function article(overrides: Partial<ArticleData> = {}): ArticleData {
  const id = overrides.url?.split('/').pop() ?? '1'
  return {
    siteId: '1',
    categoryId: '1',
    title: `文章 ${id}`,
    url: `https://example.com/article/${id}`,
    content: `正文内容 ${id}`,
    html: `<p>正文内容 ${id}</p>`,
    images: [`https://example.com/images/${id}.png`],
    contentHash: `hash-${id}`,
    crawlTime: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('文章管理', () => {
  let app: H3
  let site: any
  let category: any

  beforeAll(async () => {
    app = startTestApp()
    site = await createSite(app, { name: '示例站点', domain: 'example.com' })
    category = await createCategory(app, {
      siteId: site.id,
      name: '新闻',
      listUrl: 'https://example.com/news',
    })

    saveCrawledArticle(
      {
        article: article({
          title: '城市更新报道',
          url: 'https://example.com/article/1',
          publishTime: '2026-01-01 09:00',
          content: '城市更新项目在本月启动，居民代表参与讨论。',
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
        rawHtml: '<html><body><h1>城市更新报道</h1></body></html>',
      },
      {},
    )

    saveCrawledArticle(
      {
        article: article({
          title: '轨道交通报道',
          url: 'https://example.com/article/2',
          publishTime: '2026-01-02 10:30',
          content: '新线路进入试运行阶段。',
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )

    saveCrawledArticle(
      {
        article: article({
          title: '社区服务报道',
          url: 'https://example.com/article/3?utm_source=wechat',
          publishTime: '2026-01-03 14:15',
          content: '社区服务中心延长开放时间。',
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
  })

  afterAll(() => stopTestApp())

  it('列表：分页、关键词、站点筛选与发布时间排序', async () => {
    const all = await call(app, '/api/articles?pageSize=2')
    expect(all.status).toBe(200)
    expect(all.body.data.total).toBe(3)
    expect(all.body.data.totalPages).toBe(2)
    expect(all.body.data.items).toHaveLength(2)

    const keyword = await call(app, '/api/articles?keyword=轨道交通')
    expect(keyword.body.data.total).toBe(1)
    expect(keyword.body.data.items[0].title).toBe('轨道交通报道')

    const filtered = await call(app, `/api/articles?siteId=${site.id}&categoryId=${category.id}`)
    expect(filtered.body.data.total).toBe(3)

    const sorted = await call(app, '/api/articles?sort=publishedAt&order=asc')
    expect(sorted.body.data.items.map((item: any) => item.title)).toEqual([
      '城市更新报道',
      '轨道交通报道',
      '社区服务报道',
    ])

    const range = await call(
      app,
      '/api/articles?publishedFrom=2026-01-02T00:00:00.000Z&publishedTo=2026-01-03T00:00:00.000Z',
    )
    expect(range.body.data.total).toBe(1)
    expect(range.body.data.items[0].title).toBe('轨道交通报道')
  })

  it('URL 规范化：带跟踪参数的地址与规范地址视为同一篇', async () => {
    const rows = getModels().article.findMany({})
    const urls = rows.map((row) => row.url).sort()
    expect(urls).toContain('https://example.com/article/3')
    expect(urls).not.toContain('https://example.com/article/3?utm_source=wechat')
  })

  it('详情包含正文、清洗后 HTML、图片与站点栏目名', async () => {
    const list = await call(app, '/api/articles?keyword=城市更新')
    const id = list.body.data.items[0].id

    const detail = await call(app, `/api/articles/${id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.content).toContain('城市更新项目')
    expect(detail.body.data.contentHtml).toContain('<p>')
    expect(detail.body.data.images).toHaveLength(1)
    expect(detail.body.data.siteName).toBe('示例站点')
    expect(detail.body.data.categoryName).toBe('新闻')

    const raw = await call(app, `/api/articles/${id}/raw`)
    expect(raw.body.data.html).toContain('<h1>城市更新报道</h1>')
  })

  it('封面图字段：显式值优先、缺省回退正文首图、都没有时为空', async () => {
    const explicit = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/cover/1',
          contentHash: 'cover-hash-1',
          coverUrl: 'https://cdn.example.com/cover-1.png',
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    const explicitDetail = await call(app, `/api/articles/${explicit.articleId}`)
    expect(explicitDetail.body.data.coverUrl).toBe('https://cdn.example.com/cover-1.png')

    // 未给封面时沿用原有行为：回退正文首图
    const fallback = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/cover/2',
          contentHash: 'cover-hash-2',
          coverUrl: null,
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    const fallbackDetail = await call(app, `/api/articles/${fallback.articleId}`)
    expect(fallbackDetail.body.data.coverUrl).toBe('https://example.com/images/2.png')

    // 既没有封面也没有图片：允许为空，不能编造地址
    const empty = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/cover/3',
          contentHash: 'cover-hash-3',
          coverUrl: null,
          images: [],
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    const emptyDetail = await call(app, `/api/articles/${empty.articleId}`)
    expect(emptyDetail.body.data.coverUrl).toBeNull()
  })

  it('内容 Hash 去重：不同 URL 相同内容只保留一条', () => {
    const first = saveCrawledArticle(
      {
        article: article({ url: 'https://example.com/dup/1', contentHash: 'same-hash', title: '重复内容' }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    expect(first.status).toBe('created')

    const second = saveCrawledArticle(
      {
        article: article({ url: 'https://example.com/dup/2', contentHash: 'same-hash', title: '重复内容' }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    expect(second.status).toBe('skipped')
    expect(second.reason).toContain('内容重复')
  })

  it('同一 URL 内容未变化时跳过，内容变化时更新', async () => {
    const unchanged = saveCrawledArticle(
      {
        article: article({ url: 'https://example.com/article/1', contentHash: 'hash-1' }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    expect(unchanged.status).toBe('skipped')

    const changed = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/article/1',
          contentHash: 'hash-1-updated',
          title: '城市更新报道（更新）',
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    expect(changed.status).toBe('updated')
    const detail = await call(app, `/api/articles/${changed.articleId}`)
    expect(detail.body.data.title).toBe('城市更新报道（更新）')
  })

  it('导出 JSON：Content-Disposition、条数上限与结构正确', async () => {
    const response = await app.request('/api/articles/export?format=json&limit=2')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-disposition')).toContain('articles-')
    expect(response.headers.get('x-export-limit')).toBe('2')

    const text = await response.text()
    const parsed = JSON.parse(text) as Array<{ id: number; title: string; images: string[] }>
    expect(parsed.length).toBe(2)
    expect(parsed[0]).toHaveProperty('contentHash')
    expect(parsed[0]).toHaveProperty('coverUrl')
    expect(Array.isArray(parsed[0]!.images)).toBe(true)
  })

  it('导出 CSV：带 BOM 表头、按行转义', async () => {
    const response = await app.request('/api/articles/export?format=csv&keyword=城市更新')
    const bytes = new Uint8Array(await response.arrayBuffer())
    // fetch 的 text() 会吃掉 BOM，这里直接检查原始字节是否为 EF BB BF
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '')
    const lines = text.trim().split('\r\n')
    expect(lines[0]).toContain('id,title,url')
    expect(lines[0]).toContain('coverUrl')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('城市更新报道')
  })

  it('删除：单个与批量，缺失的 id 单独返回', async () => {
    const list = await call(app, '/api/articles?keyword=轨道交通')
    const id = list.body.data.items[0].id

    const single = await call(app, `/api/articles/${id}`, { method: 'DELETE' })
    expect(single.status).toBe(200)

    const missing = await call(app, `/api/articles/${id}`, { method: 'DELETE' })
    expect(missing.status).toBe(404)

    const rows = getModels().article.findMany({})
    const ids = rows.slice(0, 2).map((row) => row.id)
    const batch = await call(
      app,
      '/api/articles/batch-delete',
      json({ ids: [...ids, 99_999] }),
    )
    expect(batch.status).toBe(200)
    expect(batch.body.data.deleted).toBe(ids.length)
    expect(batch.body.data.missing).toEqual([99_999])
  })
})
