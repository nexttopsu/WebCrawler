/**
 * 调试数据 API（独立库 `data/debug.db`）验收测试。
 *
 * 覆盖三件事：
 * 1. 管理接口：列表不返回 raw、新增 / 编辑 / 单删 / 批量筛选删除、网址唯一、
 *    批量设置「可覆盖」；
 * 2. 与测试器联动：网址完全匹配时直接返回存档 raw，不发真实请求；
 * 3. 边界：无条件的批量删除 / 批量修改被拒绝。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { call, createCategory, createRule, createSite, getTestRuntime, json, sampleConfig, startTestApp, stopTestApp } from './helpers/app.js'

let app: H3

const ARTICLE_HTML = `<!doctype html>
<html>
  <head><title>调试存档页</title></head>
  <body>
    <h1>离线标题</h1>
    <div class="content">这是来自调试数据的正文。</div>
  </body>
</html>`

const LIST_HTML = `<!doctype html>
<html><body>
  <ul class="list">
    <li class="item"><a href="/a/1.html">第一篇</a></li>
    <li class="item"><a href="/a/2.html">第二篇</a></li>
  </ul>
</body></html>`

const ARTICLE_URL = 'https://debug.local/article/1.html'
const LIST_URL = 'https://debug.local/news'

async function create(url: string, raw: string, extra: Record<string, unknown> = {}): Promise<any> {
  const response = await call(app, '/api/debug-data', json({ url, raw, ...extra }))
  if (response.status !== 201) {
    throw new Error(`创建调试数据失败：${JSON.stringify(response.body)}`)
  }
  return response.body.data
}

beforeAll(() => {
  app = startTestApp()
})

afterAll(() => {
  stopTestApp()
})

describe('调试数据管理接口', () => {
  it('新增后列表不返回 raw，只给出大小与命中信息', async () => {
    const created = await create(ARTICLE_URL, ARTICLE_HTML, { note: '文章页存档' })
    expect(created).toMatchObject({
      url: ARTICLE_URL,
      contentType: 'html',
      statusCode: 200,
      overridable: true,
      note: '文章页存档',
      hitCount: 0,
    })
    expect(created.raw).toBe(ARTICLE_HTML)

    const response = await call(app, '/api/debug-data?keyword=debug.local')
    expect(response.status).toBe(200)
    const row = response.body.data.items.find((item: { id: number }) => item.id === created.id)
    expect(row).toBeDefined()
    // 列表刻意不带 raw，避免长文本把接口撑爆
    expect(row.raw).toBeUndefined()
    expect(row.rawSize).toBe(Buffer.byteLength(ARTICLE_HTML, 'utf8'))
  })

  it('详情接口返回 raw，可按 id 直接查看', async () => {
    const created = await create('https://debug.local/detail-only.html', '<html><body>raw</body></html>')
    const response = await call(app, `/api/debug-data/${created.id}`)
    expect(response.status).toBe(200)
    expect(response.body.data.raw).toBe('<html><body>raw</body></html>')
  })

  it('同一网址重复新增返回 409', async () => {
    const response = await call(app, '/api/debug-data', json({ url: ARTICLE_URL, raw: '<html></html>' }))
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
  })

  it('编辑 raw 与备注后立即生效', async () => {
    const created = await create('https://debug.local/edit.html', '<html><body>v1</body></html>')
    const response = await call(
      app,
      `/api/debug-data/${created.id}`,
      json({ raw: '<html><body>v2</body></html>', note: '已更新', contentType: 'json' }, 'PUT'),
    )
    expect(response.status).toBe(200)
    expect(response.body.data.raw).toBe('<html><body>v2</body></html>')
    expect(response.body.data.contentType).toBe('json')
    expect(response.body.data.note).toBe('已更新')
  })

  it('非法网址与空 raw 被拒绝', async () => {
    const badUrl = await call(app, '/api/debug-data', json({ url: 'ftp://x/y', raw: 'x' }))
    expect(badUrl.status).toBe(400)
    const emptyRaw = await call(app, '/api/debug-data', json({ url: 'https://debug.local/empty', raw: '' }))
    expect(emptyRaw.status).toBe(400)
  })

  it('单条删除后不存在', async () => {
    const created = await create('https://debug.local/to-delete.html', '<html></html>')
    const removed = await call(app, `/api/debug-data/${created.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(removed.body.data.deleted).toBe(1)

    const missing = await call(app, `/api/debug-data/${created.id}`)
    expect(missing.status).toBe(404)
  })

  it('批量删除支持勾选的 ids', async () => {
    const a = await create('https://debug.local/batch-a.html', '<html>a</html>')
    const b = await create('https://debug.local/batch-b.html', '<html>b</html>')
    await create('https://debug.local/batch-c.html', '<html>c</html>')

    const response = await call(app, `/api/debug-data?ids=${a.id},${b.id}`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(response.body.data.deleted).toBe(2)

    const rest = await call(app, '/api/debug-data?keyword=batch-')
    expect(rest.body.data.items.map((item: { url: string }) => item.url)).toEqual([
      'https://debug.local/batch-c.html',
    ])
  })

  it('批量删除支持按筛选条件（关键词 + 类型）', async () => {
    await create('https://debug.local/filter-1.html', '{"a":1}', { contentType: 'json', note: 'filter-json' })
    await create('https://debug.local/filter-2.html', '<html></html>', { note: 'filter-json' })

    const response = await call(app, '/api/debug-data?keyword=filter-json&contentType=json', {
      method: 'DELETE',
    })
    expect(response.status).toBe(200)
    expect(response.body.data.deleted).toBe(1)
  })

  it('没有任何条件的批量删除被拒绝', async () => {
    const response = await call(app, '/api/debug-data', { method: 'DELETE' })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('编辑可覆盖：单条锁定后捕获浏览器不再更新它', async () => {
    const created = await create('https://debug.local/locked.html', '<html>v1</html>')
    expect(created.overridable).toBe(true)

    const locked = await call(
      app,
      `/api/debug-data/${created.id}`,
      json({ overridable: false }, 'PUT'),
    )
    expect(locked.status).toBe(200)
    expect(locked.body.data.overridable).toBe(false)
  })

  it('批量设置可覆盖：按勾选的 ids 锁定', async () => {
    const a = await create('https://debug.local/lock-a.html', '<html>a</html>')
    const b = await create('https://debug.local/lock-b.html', '<html>b</html>')
    await create('https://debug.local/lock-c.html', '<html>c</html>')

    const response = await call(
      app,
      `/api/debug-data/overridable?overridable=false&ids=${a.id},${b.id}`,
      { method: 'PATCH' },
    )
    expect(response.status).toBe(200)
    expect(response.body.data.updated).toBe(2)

    const rest = await call(app, '/api/debug-data?keyword=lock-')
    const byUrl = Object.fromEntries(
      rest.body.data.items.map((item: { url: string; overridable: boolean }) => [item.url, item.overridable]),
    )
    expect(byUrl['https://debug.local/lock-a.html']).toBe(false)
    expect(byUrl['https://debug.local/lock-b.html']).toBe(false)
    expect(byUrl['https://debug.local/lock-c.html']).toBe(true)
  })

  it('批量设置可覆盖：按筛选条件（关键词）放开', async () => {
    await create('https://debug.local/unlock-1.html', '<html>1</html>', { overridable: false })
    await create('https://debug.local/unlock-2.html', '<html>2</html>', { overridable: false })

    const response = await call(
      app,
      '/api/debug-data/overridable?overridable=true&keyword=unlock-',
      { method: 'PATCH' },
    )
    expect(response.status).toBe(200)
    expect(response.body.data.updated).toBe(2)

    const rest = await call(app, '/api/debug-data?keyword=unlock-&overridable=false')
    expect(rest.body.data.total).toBe(0)
  })

  it('批量设置可覆盖：缺少目标值或范围都被拒绝', async () => {
    // 没有范围
    const noScope = await call(app, '/api/debug-data/overridable?overridable=false', {
      method: 'PATCH',
    })
    expect(noScope.status).toBe(400)

    // 没有目标值
    const noValue = await call(app, '/api/debug-data/overridable?keyword=x', {
      method: 'PATCH',
    })
    expect(noValue.status).toBe(400)
  })

  it('列表可按「可覆盖」筛选', async () => {
    const response = await call(app, '/api/debug-data?keyword=lock-&overridable=false')
    expect(response.status).toBe(200)
    expect(response.body.data.total).toBe(2)
  })
})

describe('采集 / 测试命中调试数据', () => {
  const hitUrl = 'https://debug.local/article-hit.html'

  it('详情测试命中存档 raw：不发请求也能提取字段', async () => {
    await create(hitUrl, ARTICLE_HTML, { note: '详情命中' })

    const response = await call(
      app,
      '/api/tester/detail',
      json({
        url: hitUrl,
        fields: {
          title: { type: 'text', selector: 'h1' },
          content: { type: 'html', selector: '.content', required: true },
        },
      }),
    )

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.ok).toBe(true)
    // 标记来源，界面据此提示「没有真的访问站点」
    expect(data.debug).toBe(true)
    expect(data.message).toContain('调试数据')
    expect(data.article.title).toBe('离线标题')
    expect(data.article.content).toContain('来自调试数据的正文')

    // 命中计数 +1，便于判断这条数据是否还在被使用
    const detail = await call(app, '/api/debug-data?keyword=article-hit.html')
    expect(detail.body.data.items[0].hitCount).toBeGreaterThanOrEqual(1)
  })

  it('列表测试命中存档 raw，相对链接按存档网址补全', async () => {
    await create(LIST_URL, LIST_HTML, { note: '列表命中' })

    const response = await call(
      app,
      '/api/tester/list',
      json({
        url: LIST_URL,
        list: { itemSelector: '.item', titleSelector: 'a' },
      }),
    )

    expect(response.status).toBe(200)
    const data = response.body.data
    expect(data.debug).toBe(true)
    expect(data.itemCount).toBe(2)
    expect(data.links.map((link: { url: string }) => link.url)).toEqual([
      'https://debug.local/a/1.html',
      'https://debug.local/a/2.html',
    ])
  })

  it('页面快照命中存档 raw，并在结果里标记来源', async () => {
    await create('https://debug.local/snapshot.html', ARTICLE_HTML)

    const response = await call(
      app,
      '/api/tester/snapshot',
      json({ url: 'https://debug.local/snapshot.html' }),
    )
    expect(response.status).toBe(200)
    expect(response.body.data.ok).toBe(true)
    expect(response.body.data.debug).toBe(true)
    expect(response.body.data.html).toContain('来自调试数据的正文')
  })

  it('锁定（不可覆盖）的调试数据仍参与匹配，只是捕获浏览器不更新它', async () => {
    const created = await create('https://debug.local/locked-hit.html', ARTICLE_HTML, {
      overridable: false,
    })

    const response = await call(
      app,
      '/api/tester/detail',
      json({
        url: 'https://debug.local/locked-hit.html',
        fields: { content: { type: 'html', selector: '.content' } },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.body.data.debug).toBe(true)
    expect(response.body.data.ok).toBe(true)
    expect(created.overridable).toBe(false)
  })
})

describe('采集任务命中调试数据', () => {
  it('列表与详情都走存档 raw：站点不可达也能完成采集', async () => {
    // 站点域名是 debug.local，真实网络里并不存在，能跑通就证明没有发请求
    const site = await createSite(app, {
      name: '离线调试站点',
      domain: 'debug.local',
      baseUrl: 'https://debug.local',
    })
    const category = await createCategory(app, {
      siteId: site.id,
      name: '离线栏目',
      listUrl: 'https://debug.local/task-news',
    })
    const rule = await createRule(app, {
      siteId: site.id,
      name: '离线规则',
      config: sampleConfig({
        request: { mode: 'http', method: 'GET', timeoutMs: 5000 },
        list: {
          itemSelector: '.item',
          linkSelector: 'a',
          titleSelector: 'a',
          pagination: { type: 'none' },
        },
        detail: {
          fields: {
            title: { type: 'text', selector: 'h1', required: true },
            content: { type: 'html', selector: '.content', required: true },
          },
        },
      }),
    })
    await call(app, `/api/categories/${category.id}`, json({ ruleId: rule.id }, 'PATCH'))

    await create('https://debug.local/task-news', LIST_HTML, { note: '任务列表存档' })
    await create(
      'https://debug.local/a/1.html',
      '<html><body><h1>第一篇</h1><div class="content">正文一</div></body></html>',
    )
    await create(
      'https://debug.local/a/2.html',
      '<html><body><h1>第二篇</h1><div class="content">正文二</div></body></html>',
    )

    const created = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, type: 'category', categoryIds: [category.id], name: '离线采集' }),
    )
    expect(created.status).toBe(201)
    await getTestRuntime().whenIdle(20_000)

    const detail = await call(app, `/api/tasks/${created.body.data.id}`)
    const task = detail.body.data
    expect(task.status).toBe('completed')
    expect(task.progress.total).toBe(2)
    expect(task.progress.success).toBe(2)

    const articles = await call(app, `/api/articles?pageSize=5&siteId=${site.id}`)
    const titles = articles.body.data.items.map((item: { title: string }) => item.title).sort()
    expect(titles).toEqual(['第一篇', '第二篇'])
  })
})
