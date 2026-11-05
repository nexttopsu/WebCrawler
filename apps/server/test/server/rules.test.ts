import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { getModels } from '../../src/database/index.js'
import {
  call,
  createCategory,
  createRule,
  createSite,
  json,
  sampleConfig,
  startTestApp,
  stopTestApp,
} from './helpers/app.js'

let app: H3
let seq = 0

function domain(label: string): string {
  seq += 1
  return `${label}${seq}.example.com`
}

beforeAll(() => {
  app = startTestApp()
})

afterAll(() => {
  stopTestApp()
})

describe('规则 CRUD 与校验', () => {
  it('创建规则：写入配置、修订号与首个版本', async () => {
    const site = await createSite(app, { name: '规则站', domain: domain('rule') })
    const response = await call(
      app,
      '/api/rules',
      json({
        siteId: site.id,
        name: '新闻规则',
        config: sampleConfig({
          request: { mode: 'http', method: 'GET', timeout: 12000 },
        }),
      }),
    )

    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({
      siteId: site.id,
      name: '新闻规则',
      version: 1,
      status: 'enabled',
      configVersion: 1,
    })
    // timeout 别名被折叠，不留下两份值
    expect(response.body.data.config.request.timeoutMs).toBe(12000)
    expect(response.body.data.config.request.timeout).toBeUndefined()

    const versions = await call(app, `/api/rules/${response.body.data.id}/versions`)
    expect(versions.body.data.items).toHaveLength(1)
    expect(versions.body.data.items[0]).toMatchObject({ version: 1, note: '创建规则' })
  })

  it('规则配置非法时返回 400 与字段级错误', async () => {
    const site = await createSite(app, { name: '非法规则站', domain: domain('bad') })

    const badPagination = await call(
      app,
      '/api/rules',
      json({
        siteId: site.id,
        name: '未实现分页',
        config: { version: 1, list: { itemSelector: '.x', pagination: { type: 'cursor' } } },
      }),
    )
    expect(badPagination.status).toBe(400)
    expect(badPagination.body.error.code).toBe('VALIDATION_ERROR')
    expect(badPagination.body.error.message).toContain('尚未实现')

    const unknownKey = await call(
      app,
      '/api/rules',
      json({ siteId: site.id, name: '未知字段', config: { version: 1, itemSelector: '.x' } }),
    )
    expect(unknownKey.status).toBe(400)
    expect(unknownKey.body.error.details.some((item: { message: string }) => item.message.includes('Unrecognized key'))).toBe(true)
  })

  it('同一站点规则名唯一，不同站点可重名', async () => {
    const siteA = await createSite(app, { name: '同名站 A', domain: domain('same') })
    const siteB = await createSite(app, { name: '同名站 B', domain: domain('same') })
    await createRule(app, { siteId: siteA.id, name: '通用规则', config: sampleConfig() })

    const conflict = await call(
      app,
      '/api/rules',
      json({ siteId: siteA.id, name: '通用规则', config: sampleConfig() }),
    )
    expect(conflict.status).toBe(409)

    const otherSite = await call(
      app,
      '/api/rules',
      json({ siteId: siteB.id, name: '通用规则', config: sampleConfig() }),
    )
    expect(otherSite.status).toBe(201)
  })

  it('列表支持作用域、状态与关键词筛选', async () => {
    const site = await createSite(app, { name: '规则筛选站', domain: domain('rfilter') })
    const category = await createCategory(app, {
      siteId: site.id,
      name: '栏目',
      listUrl: `https://${site.domain}/news`,
    })
    await createRule(app, { siteId: site.id, name: '站点级规则', config: sampleConfig() })
    await createRule(app, {
      siteId: site.id,
      name: '栏目级规则',
      categoryId: category.id,
      config: sampleConfig(),
      status: 'disabled',
    })

    const siteScope = await call(app, `/api/rules?siteId=${site.id}&scope=site`)
    expect(siteScope.body.data.total).toBe(1)
    expect(siteScope.body.data.items[0].name).toBe('站点级规则')

    const disabled = await call(app, `/api/rules?siteId=${site.id}&status=disabled`)
    expect(disabled.body.data.total).toBe(1)
    expect(disabled.body.data.items[0].name).toBe('栏目级规则')

    const keyword = await call(app, `/api/rules?siteId=${site.id}&keyword=${encodeURIComponent('站点级')}`)
    expect(keyword.body.data.total).toBe(1)
  })

  it('状态切换生效', async () => {
    const site = await createSite(app, { name: '规则状态站', domain: domain('rstatus') })
    const rule = await createRule(app, { siteId: site.id, name: '待禁用规则', config: sampleConfig() })

    const response = await call(app, `/api/rules/${rule.id}/status`, json({ status: 'disabled' }, 'PATCH'))
    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('disabled')
  })

  it('不存在的规则返回 404', async () => {
    expect((await call(app, '/api/rules/999999')).status).toBe(404)
    expect((await call(app, '/api/rules/999999/versions')).status).toBe(404)
  })
})

describe('规则版本', () => {
  it('配置变化生成新版本，改名不产生版本', async () => {
    const site = await createSite(app, { name: '版本站', domain: domain('ver') })
    const rule = await createRule(app, { siteId: site.id, name: '版本规则', config: sampleConfig() })

    const renamed = await call(app, `/api/rules/${rule.id}`, json({ name: '改名后的规则' }, 'PATCH'))
    expect(renamed.body.data.version).toBe(1)

    const updated = await call(
      app,
      `/api/rules/${rule.id}`,
      json({ config: sampleConfig({ validate: { minContentLength: 100 } }) }, 'PATCH'),
    )
    expect(updated.status).toBe(200)
    expect(updated.body.data.version).toBe(2)
    expect(updated.body.data.config.validate.minContentLength).toBe(100)

    const versions = await call(app, `/api/rules/${rule.id}/versions`)
    expect(versions.body.data.items.map((item: { version: number }) => item.version)).toEqual([2, 1])

    const v1 = await call(app, `/api/rules/${rule.id}/versions/1`)
    expect(v1.status).toBe(200)
    expect(v1.body.data.version).toBe(1)
    expect(v1.body.data.config.validate).toBeUndefined()

    const missing = await call(app, `/api/rules/${rule.id}/versions/99`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.details.available).toEqual([1, 2])
  })

  it('相同配置重复保存不产生新版本', async () => {
    const site = await createSite(app, { name: '幂等站', domain: domain('idem') })
    const rule = await createRule(app, { siteId: site.id, name: '幂等规则', config: sampleConfig() })

    const again = await call(
      app,
      `/api/rules/${rule.id}`,
      json({ config: sampleConfig() }, 'PATCH'),
    )
    expect(again.status).toBe(200)
    expect(again.body.data.version).toBe(1)

    const versions = await call(app, `/api/rules/${rule.id}/versions`)
    expect(versions.body.data.items).toHaveLength(1)
  })

  it('PUT 要求完整配置', async () => {
    const site = await createSite(app, { name: 'PUT 站', domain: domain('put') })
    const rule = await createRule(app, { siteId: site.id, name: 'PUT 规则', config: sampleConfig() })

    const missing = await call(app, `/api/rules/${rule.id}`, json({ name: '只改名字' }, 'PUT'))
    expect(missing.status).toBe(400)

    const replaced = await call(
      app,
      `/api/rules/${rule.id}`,
      json({ name: '整体替换', config: sampleConfig({ clean: { keepImages: false } }) }, 'PUT'),
    )
    expect(replaced.status).toBe(200)
    expect(replaced.body.data.description).toBeNull()
    expect(replaced.body.data.version).toBe(2)
  })
})

describe('规则继承', () => {
  it('站点默认规则 < 栏目规则 < 任务覆盖', async () => {
    const site = await createSite(app, { name: '继承站', domain: domain('inherit') })
    const defaultRule = await createRule(app, {
      siteId: site.id,
      name: '站点默认',
      config: sampleConfig({
        list: {
          itemSelector: '.site-item',
          pagination: { type: 'query', parameter: 'page' },
        },
        detail: { fields: { title: { type: 'text', selector: 'h1' }, content: { type: 'html', selector: '.c' } } },
      }),
    })
    const categoryRule = await createRule(app, {
      siteId: site.id,
      name: '栏目覆盖',
      config: { version: 1, detail: { fields: { title: { type: 'text', selector: 'h2' } } } },
    })
    const category = await createCategory(app, {
      siteId: site.id,
      name: '继承栏目',
      listUrl: `https://${site.domain}/news`,
      ruleId: categoryRule.id,
    })

    const bound = await call(app, `/api/sites/${site.id}`, json({ defaultRuleId: defaultRule.id }, 'PATCH'))
    expect(bound.status).toBe(200)

    const resolved = await call(app, '/api/rules/resolve', json({ siteId: site.id, categoryId: category.id }))
    expect(resolved.status).toBe(200)
    expect(resolved.body.data.sources.map((item: { scope: string }) => item.scope)).toEqual([
      'site',
      'category',
    ])
    expect(resolved.body.data.config.list.itemSelector).toBe('.site-item')
    expect(resolved.body.data.config.detail.fields.title.selector).toBe('h2')
    expect(resolved.body.data.config.detail.fields.content.selector).toBe('.c')
    expect(resolved.body.data.paginationType).toBe('query')
    expect(resolved.body.data.mergeStrategy).toContain('数组整体替换')

    const withOverride = await call(
      app,
      '/api/rules/resolve',
      json({
        siteId: site.id,
        categoryId: category.id,
        override: {
          version: 1,
          list: { itemSelector: '.override-item' },
          validate: { minContentLength: 50 },
        },
      }),
    )
    expect(withOverride.body.data.sources.at(-1)).toMatchObject({ scope: 'task', ruleId: null })
    expect(withOverride.body.data.config.list.itemSelector).toBe('.override-item')
    expect(withOverride.body.data.config.validate.minContentLength).toBe(50)
  })

  it('没有配置来源时返回空配置', async () => {
    const site = await createSite(app, { name: '空规则站', domain: domain('empty') })

    const response = await call(app, '/api/rules/resolve', json({ siteId: site.id }))
    expect(response.status).toBe(200)
    expect(response.body.data.config).toBeNull()
    expect(response.body.data.sources).toEqual([])
    expect(response.body.data.paginationType).toBeNull()
  })

  it('栏目不属于站点时拒绝计算', async () => {
    const siteA = await createSite(app, { name: '归属 A', domain: domain('own') })
    const siteB = await createSite(app, { name: '归属 B', domain: domain('own') })
    const category = await createCategory(app, {
      siteId: siteA.id,
      name: 'A 的栏目',
      listUrl: `https://${siteA.domain}/news`,
    })

    const response = await call(
      app,
      '/api/rules/resolve',
      json({ siteId: siteB.id, categoryId: category.id }),
    )
    expect(response.status).toBe(400)
    expect(response.body.error.message).toContain('栏目不属于该站点')
  })
})

describe('规则删除约束', () => {
  it('被栏目引用时默认拒绝，force 后解除引用', async () => {
    const site = await createSite(app, { name: '删除规则站', domain: domain('rdel') })
    const rule = await createRule(app, { siteId: site.id, name: '被引用的规则', config: sampleConfig() })
    const category = await createCategory(app, {
      siteId: site.id,
      name: '引用栏目',
      listUrl: `https://${site.domain}/news`,
      ruleId: rule.id,
    })

    const blocked = await call(app, `/api/rules/${rule.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.categories).toHaveLength(1)

    const forced = await call(app, `/api/rules/${rule.id}?force=true`, { method: 'DELETE' })
    expect(forced.status).toBe(200)
    expect(forced.body.data.detached).toBe(1)

    const after = await call(app, `/api/categories/${category.id}`)
    expect(after.body.data.ruleId).toBeNull()
    expect((await call(app, `/api/rules/${rule.id}`)).status).toBe(404)
  })

  it('被历史任务引用时永远拒绝', async () => {
    const site = await createSite(app, { name: '任务引用站', domain: domain('taskref') })
    const rule = await createRule(app, { siteId: site.id, name: '任务规则', config: sampleConfig() })
    getModels().crawlTask.create({
      siteId: site.id,
      ruleId: rule.id,
      name: '历史任务',
      status: 'success',
      ruleVersion: 1,
    })

    const blocked = await call(app, `/api/rules/${rule.id}?force=true`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.counts.tasks).toBe(1)
  })

  it('站点默认规则不能直接删除，也不能改成栏目规则', async () => {
    const site = await createSite(app, { name: '默认规则站', domain: domain('default') })
    const rule = await createRule(app, { siteId: site.id, name: '默认规则', config: sampleConfig() })
    const category = await createCategory(app, {
      siteId: site.id,
      name: '栏目',
      listUrl: `https://${site.domain}/news`,
    })
    await call(app, `/api/sites/${site.id}`, json({ defaultRuleId: rule.id }, 'PATCH'))

    const blocked = await call(app, `/api/rules/${rule.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.details.sites).toHaveLength(1)

    const toCategory = await call(
      app,
      `/api/rules/${rule.id}`,
      json({ categoryId: category.id }, 'PATCH'),
    )
    expect(toCategory.status).toBe(409)
  })
})
