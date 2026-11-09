import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { call, createCategory, createSite, json, startTestApp, stopTestApp } from './helpers/app.js'
import { saveCrawledArticle } from '../../src/server/services/article-service.js'
import type { ArticleData } from '../../src/shared/index.js'

function article(overrides: Partial<ArticleData> = {}): ArticleData {
  return {
    siteId: '1',
    categoryId: '1',
    title: '示例文章',
    url: 'https://example.com/article/1',
    content: '正文内容',
    ...overrides,
  }
}

describe('开放只读接口', () => {
  let app: H3
  let site: any
  let otherSite: any
  let newsCategory: any
  let financeCategory: any

  beforeAll(async () => {
    app = startTestApp()
    site = await createSite(app, { name: '示例站点', domain: 'example.com' })
    otherSite = await createSite(app, { name: '另一个站点', domain: 'other.com', baseUrl: 'https://other.com' })

    newsCategory = await createCategory(app, {
      siteId: site.id,
      name: '新闻',
      code: 'news',
      listUrl: 'https://example.com/news',
      sortOrder: 20,
    })
    financeCategory = await createCategory(app, {
      siteId: site.id,
      name: '财经',
      code: 'finance',
      listUrl: 'https://example.com/finance',
      sortOrder: 10,
      parentId: newsCategory.id,
    })

    const seed = (
      title: string,
      url: string,
      articleTime: string | undefined,
      extra: Partial<ArticleData> = {},
      targetSite = site,
      targetCategory: any = newsCategory,
    ): void => {
      saveCrawledArticle(
        {
          article: article({ title, url, ...(articleTime ? { articleTime } : {}), ...extra }),
          siteId: targetSite.id,
          categoryId: targetCategory?.id ?? null,
          taskId: null,
        },
        {},
      )
    }

    seed('城市更新报道', 'https://example.com/article/1', '2026-01-01 09:00', {
      author: '记者 张三',
      summary: '城市更新项目启动。',
    })
    seed('轨道交通报道', 'https://example.com/article/2', '2026-01-02 10:30', {
      author: '记者 李四',
      summary: '<p>新线路<b>试运行</b>&nbsp;阶段。</p>',
    })
    seed('社区服务报道', 'https://example.com/article/3', '2026-01-03 14:15', { author: '记者 王五' })
    // 没有文章时间的记录：任何排序都应排在最后
    seed('没有时间的报道', 'https://example.com/article/4', undefined)
    seed('财经观察', 'https://example.com/article/5', '2026-01-04 08:00', {}, site, financeCategory)
    seed('外部站点文章', 'https://other.com/article/1', '2026-01-05 08:00', {}, otherSite, null)
    // metadata 会存进 extra 列，详情接口应原样带出
    seed('带扩展字段的报道', 'https://example.com/article/6', '2026-01-06 09:00', {
      metadata: { source: 'rss', readCount: 100 },
    })
  })

  afterAll(() => {
    stopTestApp()
  })

  it('网站列表一次返回全部网站，每个网站带自己的栏目', async () => {
    const response = await call(app, '/api/open/sites')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)

    const data = response.body.data
    // data 直接是数组（不分页），没有 page / total 之类的包装
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)

    const [first, second] = data
    expect(Object.keys(first).sort()).toEqual(['columns', 'createdAt', 'id', 'name'])
    expect(first).toMatchObject({ id: site.id, name: '示例站点' })
    expect(first.createdAt).toEqual(expect.any(String))

    // 栏目挂在所属网站下，按 sortOrder 升序（财经 10 在新闻 20 前面）
    expect(first.columns.map((column: any) => column.name)).toEqual(['财经', '新闻'])
    expect(first.columns[0]).toMatchObject({
      id: financeCategory.id,
      parentId: newsCategory.id,
      sortOrder: 10,
      code: 'finance',
      siteId: site.id,
    })
    expect(Object.keys(first.columns[0]).sort()).toEqual([
      'code',
      'createdAt',
      'id',
      'name',
      'parentId',
      'siteId',
      'sortOrder',
    ])

    // 没有栏目的网站返回空数组，而不是缺字段
    expect(second).toMatchObject({ id: otherSite.id, name: '另一个站点', columns: [] })
  })

  it('网站接口忽略分页参数，不会截断', async () => {
    // 对接方沿用分页写法多传 page / pageSize 时不报错，也不截断
    const response = await call(app, '/api/open/sites?page=2&pageSize=1')
    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(2)
  })

  it('文章列表默认按文章时间倒序，缺少时间的记录排最后', async () => {
    const response = await call(app, '/api/open/articles?pageSize=100')
    expect(response.status).toBe(200)
    const titles = response.body.data.items.map((item: any) => item.title)
    expect(titles).toEqual([
      '带扩展字段的报道',
      '外部站点文章',
      '财经观察',
      '社区服务报道',
      '轨道交通报道',
      '城市更新报道',
      '没有时间的报道',
    ])
  })

  it('文章列表支持正序、网站 / 栏目 / 标题关键词筛选', async () => {
    const asc = await call(app, '/api/open/articles?order=asc&pageSize=100')
    expect(asc.body.data.items.map((item: any) => item.title)).toEqual([
      '城市更新报道',
      '轨道交通报道',
      '社区服务报道',
      '财经观察',
      '外部站点文章',
      '带扩展字段的报道',
      '没有时间的报道',
    ])

    const bySite = await call(app, `/api/open/articles?siteId=${otherSite.id}`)
    expect(bySite.body.data.total).toBe(1)
    expect(bySite.body.data.items[0].title).toBe('外部站点文章')

    const byCategory = await call(app, `/api/open/articles?categoryId=${financeCategory.id}`)
    expect(byCategory.body.data.total).toBe(1)
    expect(byCategory.body.data.items[0].categoryName).toBe('财经')

    const byKeyword = await call(app, '/api/open/articles?keyword=' + encodeURIComponent('报道'))
    expect(byKeyword.body.data.total).toBe(5)
    for (const item of byKeyword.body.data.items) {
      expect(item.title).toContain('报道')
    }
  })

  it('文章列表返回归属名称且不含正文', async () => {
    const response = await call(app, '/api/open/articles?keyword=' + encodeURIComponent('城市更新'))
    const [item] = response.body.data.items
    expect(item).toMatchObject({
      title: '城市更新报道',
      siteId: site.id,
      siteName: '示例站点',
      categoryId: newsCategory.id,
      categoryName: '新闻',
      author: '记者 张三',
      summary: '城市更新项目启动。',
    })
    expect(item.content).toBeUndefined()
    expect(item.taskId).toBeUndefined()
    expect(item.detailStatus).toBeUndefined()
    expect(Object.keys(item).sort()).toEqual([
      'articleTime',
      'author',
      'categoryId',
      'categoryName',
      'coverUrl',
      'id',
      'siteId',
      'siteName',
      'summary',
      'title',
      'url',
    ])
  })

  it('摘要返回纯文本：去标签、解实体、压缩空白', async () => {
    const response = await call(app, '/api/open/articles?keyword=' + encodeURIComponent('轨道交通'))
    expect(response.body.data.items[0].summary).toBe('新线路试运行 阶段。')
  })

  it('文章列表分页参数生效，越界 pageSize 返回 400', async () => {
    const firstPage = await call(app, '/api/open/articles?page=1&pageSize=2&order=desc')
    expect(firstPage.body.data.items).toHaveLength(2)
    expect(firstPage.body.data.totalPages).toBe(4)

    const secondPage = await call(app, '/api/open/articles?page=2&pageSize=2&order=desc')
    expect(secondPage.body.data.items.map((item: any) => item.title)).toEqual([
      '财经观察',
      '社区服务报道',
    ])

    const tooLarge = await call(app, '/api/open/articles?pageSize=101')
    expect(tooLarge.status).toBe(400)
    expect(tooLarge.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('文章详情返回正文，缺失与非法 id 分别 404 / 400', async () => {
    const list = await call(app, '/api/open/articles?keyword=' + encodeURIComponent('城市更新'))
    const id = list.body.data.items[0].id

    const detail = await call(app, `/api/open/articles/${id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data).toMatchObject({ id, title: '城市更新报道', content: '正文内容' })
    // 无自定义字段时 extra 为空对象（不是 null / undefined）
    expect(detail.body.data.extra).toEqual({})

    // 采集 metadata 存进 extra，详情接口原样返回
    const extraList = await call(app, '/api/open/articles?keyword=' + encodeURIComponent('带扩展字段'))
    const extraId = extraList.body.data.items[0].id
    const extraDetail = await call(app, `/api/open/articles/${extraId}`)
    expect(extraDetail.body.data.extra).toEqual({ source: 'rss', readCount: 100 })
    // 列表接口不返回 extra（摘要场景用不上，也减小响应体积）
    expect(extraList.body.data.items[0].extra).toBeUndefined()

    const missing = await call(app, '/api/open/articles/999999')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('NOT_FOUND')

    const invalid = await call(app, '/api/open/articles/abc')
    expect(invalid.status).toBe(400)
  })

  it('开放前缀只读：非 GET 方法返回 405', async () => {
    const response = await call(app, '/api/open/sites', json({ name: 'x' }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('文档接口返回与页面同源的接口描述', async () => {
    const response = await call(app, '/api/open/docs')
    expect(response.status).toBe(200)
    expect(response.body.data.baseUrl).toBe('/api/open')
    const paths = response.body.data.endpoints.map((endpoint: any) => endpoint.path)
    expect(paths).toEqual(['/api/open/sites', '/api/open/articles', '/api/open/articles/:id'])

    // 网站接口 data 是数组（kind=array），文章接口分页（kind=page）
    const kinds = Object.fromEntries(
      response.body.data.endpoints.map((endpoint: any) => [endpoint.id, endpoint.response.kind]),
    )
    expect(kinds).toMatchObject({ sites: 'array', articles: 'page' })

    // 网站接口不能再声明分页参数，且要说明 columns 的字段
    const sitesEndpoint = response.body.data.endpoints.find((endpoint: any) => endpoint.id === 'sites')
    expect(sitesEndpoint.params).toEqual([])
    expect(sitesEndpoint.response.nested.fields.map((field: any) => field.name)).toContain('parentId')

    // 文档里声明的每条 GET 路径都必须真实可访问
    for (const endpoint of response.body.data.endpoints) {
      const url = endpoint.path.replace(':id', String(1))
      const called = await call(app, url)
      expect(called.status, `${url} 应可访问`).toBeLessThan(400)
    }
  })
})
