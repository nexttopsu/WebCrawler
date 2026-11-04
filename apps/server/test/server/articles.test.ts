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
          articleTime: '2026-01-01 09:00',
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
          articleTime: '2026-01-02 10:30',
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
          articleTime: '2026-01-03 14:15',
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

  it('列表：分页、关键词、站点筛选与文章时间排序', async () => {
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

    const sorted = await call(app, '/api/articles?sort=articleTime&order=asc')
    expect(sorted.body.data.items.map((item: any) => item.title)).toEqual([
      '城市更新报道',
      '轨道交通报道',
      '社区服务报道',
    ])

    const range = await call(
      app,
      '/api/articles?articleTimeFrom=2026-01-02T00:00:00.000Z&articleTimeTo=2026-01-03T00:00:00.000Z',
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

  it('详情包含正文、文章时间与站点栏目名', async () => {
    const list = await call(app, '/api/articles?keyword=城市更新')
    const id = list.body.data.items[0].id

    const detail = await call(app, `/api/articles/${id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.content).toContain('城市更新项目')
    expect(detail.body.data.siteName).toBe('示例站点')
    expect(detail.body.data.categoryName).toBe('新闻')
    expect(detail.body.data.articleTime).toMatch(/^2026-01-01T/)

    const raw = await call(app, `/api/articles/${id}/raw`)
    expect(raw.body.data.html).toContain('<h1>城市更新报道</h1>')
  })

  it('封面图字段：显式值优先、未给封面时为空', async () => {
    const explicit = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/cover/1',
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

    // 既没有封面：允许为空，不能编造地址（不再回退正文首图）
    const empty = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/cover/3',
          coverUrl: null,
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

  it('同一 URL 再次采集时直接更新，不再按内容 Hash 跳过', async () => {
    const outcome = saveCrawledArticle(
      {
        article: article({
          url: 'https://example.com/article/1',
          title: '城市更新报道（更新）',
          content: '城市更新项目有新进展，居民代表再次参与讨论。',
        }),
        siteId: site.id,
        categoryId: category.id,
        taskId: null,
      },
      {},
    )
    expect(outcome.status).toBe('updated')
    expect(outcome.articleId).toBeDefined()

    const detail = await call(app, `/api/articles/${outcome.articleId}`)
    expect(detail.body.data.title).toBe('城市更新报道（更新）')
    expect(detail.body.data.content).toContain('新进展')
  })

  it('导出 JSON：Content-Disposition、条数上限与结构正确', async () => {
    const response = await app.request('/api/articles/export?format=json&limit=2')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-disposition')).toContain('articles-')
    expect(response.headers.get('x-export-limit')).toBe('2')

    const text = await response.text()
    const parsed = JSON.parse(text) as Array<{ id: number; title: string; articleTime: string | null }>
    expect(parsed.length).toBe(2)
    expect(parsed[0]).toHaveProperty('articleTime')
    expect(parsed[0]).toHaveProperty('coverUrl')
    expect(parsed[0]).toHaveProperty('detailStatus')
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
