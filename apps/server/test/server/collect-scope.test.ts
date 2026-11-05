import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '../../src/database/index.js'
import {
  call,
  createCategory,
  createRule,
  createSite,
  getTestRuntime,
  json,
  sampleConfig,
  startTestApp,
  stopTestApp,
} from './helpers/app.js'
import { startSiteFixture, type SiteFixture } from './helpers/site-fixture.js'

/**
 * 规则里的采集范围 `collectScope: 'list'` 对普通任务的影响。
 *
 * 这是「只采列表 / 列表 + 内容」的规则侧入口：单栏目任务本该抓详情，
 * 但规则要求仅列表时，执行器必须只入库标题与链接，详情留待补采。
 * 独立起 fixture 与站点，避免与其他用例共享 URL 影响计数。
 */
describe('采集范围：规则设为仅列表', () => {
  let app: H3
  let fixture: SiteFixture
  let site: any
  let category: any

  beforeAll(async () => {
    fixture = await startSiteFixture()
    app = startTestApp({ allowPrivateNetwork: true })
    site = await createSite(app, {
      name: '仅列表站点',
      domain: '127.0.0.1',
      baseUrl: fixture.origin,
    })
    category = await createCategory(app, {
      siteId: site.id,
      name: '仅列表栏目',
      listUrl: `${fixture.origin}/news`,
    })
    const rule = await createRule(app, {
      siteId: site.id,
      name: '仅列表规则',
      config: sampleConfig({
        collectScope: 'list',
        detail: {
          fields: {
            title: { type: 'text', selector: 'h1.article-title', required: true },
            content: { type: 'html', selector: '.article-content' },
          },
        },
      }),
    })
    const patched = await call(app, `/api/categories/${category.id}`, json({ ruleId: rule.id }, 'PATCH'))
    expect(patched.status).toBe(200)
  })

  afterAll(async () => {
    stopTestApp()
    await fixture.close()
  })

  it('普通栏目任务只入库列表数据，详情状态为 pending', async () => {
    const created = await call(
      app,
      '/api/tasks',
      json({ siteId: site.id, type: 'category', categoryIds: [category.id], name: '仅列表任务' }),
    )
    expect(created.status).toBe(201)
    await getTestRuntime().whenIdle(20_000)

    const finished = await call(app, `/api/tasks/${created.body.data.id}`)
    expect(finished.body.data.status).toBe('completed')

    const rows = getModels().article.findMany({ siteId: site.id })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.detailStatus).toBe('pending')
      expect(row.content ?? '').toBe('')
    }
  })
})
