import { describe, expect, it } from 'vitest'
import {
  isDeepEqual,
  mergeRuleConfig,
  mergeRuleConfigChain,
  normalizeRuleConfig,
  RULE_MERGE_STRATEGY,
  type CrawlRuleConfig,
} from '../../src/shared/index.js'

const base: CrawlRuleConfig = {
  version: 1,
  request: {
    mode: 'http',
    timeoutMs: 15000,
    headers: { 'user-agent': 'base', accept: 'text/html' },
  },
  list: {
    itemSelector: '.item',
    linkSelector: 'a',
    pagination: { type: 'query', parameter: 'page', maxPages: 5 },
  },
  clean: { removeSelectors: ['.ad', '.sidebar'], keepImages: true },
  detail: {
    fields: {
      title: { type: 'text', selector: 'h1', required: true },
      content: { type: 'html', selector: '.content' },
      author: { type: 'text', selector: '.author' },
    },
  },
  validate: { requiredFields: ['title', 'content'] },
}

describe('规则深度合并', () => {
  it('对象递归合并，未覆盖的字段保持基础值', () => {
    const merged = mergeRuleConfig(base, {
      version: 1,
      detail: { fields: { title: { type: 'text', selector: 'h2' } } },
    })

    // required 未被覆盖，应保留基础值——这是深度合并与「整块替换」的关键区别
    expect(merged.detail?.fields?.title).toEqual({ type: 'text', selector: 'h2', required: true })
    expect(merged.detail?.fields?.content).toEqual({ type: 'html', selector: '.content' })
    expect(merged.list?.itemSelector).toBe('.item')
    expect(merged.request?.timeoutMs).toBe(15000)
  })

  it('请求头按 key 合并，同名覆盖', () => {
    const merged = mergeRuleConfig(base, {
      version: 1,
      request: { headers: { accept: 'application/json', 'x-token': 'abc' } },
    })

    expect(merged.request?.headers).toEqual({
      'user-agent': 'base',
      accept: 'application/json',
      'x-token': 'abc',
    })
  })

  it('数组整体替换而不是拼接', () => {
    const merged = mergeRuleConfig(base, { version: 1, clean: { removeSelectors: ['.popup'] } })

    expect(merged.clean?.removeSelectors).toEqual(['.popup'])
    expect(merged.clean?.keepImages).toBe(true)
  })

  it('标量覆盖', () => {
    const merged = mergeRuleConfig(base, { version: 1, request: { timeoutMs: 30000 } })
    expect(merged.request?.timeoutMs).toBe(30000)
    expect(merged.request?.mode).toBe('http')
  })

  it('proxy: null 表示显式直连，覆盖上层的代理', () => {
    const withProxy = mergeRuleConfig(base, {
      version: 1,
      request: { proxy: { protocol: 'http', host: '127.0.0.1', port: 8080 } },
    })
    expect(withProxy.request?.proxy).toEqual({ protocol: 'http', host: '127.0.0.1', port: 8080 })

    const direct = mergeRuleConfig(withProxy, { version: 1, request: { proxy: null } })
    expect(direct.request?.proxy).toBeNull()
  })

  it('覆盖方缺省的分页保持基础值，且两处位置保持同步', () => {
    const merged = mergeRuleConfig(base, { version: 1, list: { itemSelector: '.news' } })
    expect(merged.list?.pagination?.parameter).toBe('page')
    expect(merged.pagination?.parameter).toBe('page')
  })

  it('任一侧为空时返回另一侧（并归一化）', () => {
    expect(mergeRuleConfig(undefined, base).list?.itemSelector).toBe('.item')
    expect(mergeRuleConfig(base, undefined).list?.itemSelector).toBe('.item')
    expect(mergeRuleConfig(undefined, undefined)).toEqual({ version: 1 })
  })

  it('合并不会修改入参', () => {
    const snapshot = structuredClone(base)
    mergeRuleConfig(base, { version: 1, list: { itemSelector: '.changed' } })
    expect(base).toEqual(snapshot)
  })

  it('不产生字段丢失：合并后原有字段仍然完整', () => {
    const merged = mergeRuleConfig(base, {
      version: 1,
      validate: { minContentLength: 100 },
    })

    expect(Object.keys(merged.detail?.fields ?? {}).sort()).toEqual(['author', 'content', 'title'])
    expect(merged.validate?.minContentLength).toBe(100)
    expect(merged.validate?.requiredFields).toEqual(['title', 'content'])
  })
})

describe('归一化', () => {
  it('把 list.pagination 同步到顶层别名', () => {
    const normalized = normalizeRuleConfig({
      version: 1,
      list: { itemSelector: '.a', pagination: { type: 'path', pathPattern: '/p/{page}' } },
    })

    expect(normalized.pagination).toEqual({ type: 'path', pathPattern: '/p/{page}' })
    expect(normalized.list?.pagination).toEqual({ type: 'path', pathPattern: '/p/{page}' })
    // 两处是独立副本，修改一处不会影响另一处
    expect(normalized.pagination).not.toBe(normalized.list?.pagination)
  })

  it('只有顶层 pagination 时回填到 list.pagination', () => {
    const normalized = normalizeRuleConfig({
      version: 1,
      list: { itemSelector: '.a' },
      pagination: { type: 'none' },
    })

    expect(normalized.list?.pagination).toEqual({ type: 'none' })
  })

  it('timeout 别名折叠为 timeoutMs', () => {
    const normalized = normalizeRuleConfig({ version: 1, request: { timeout: 8000 } })
    expect(normalized.request).toEqual({ timeoutMs: 8000 })
  })
})

describe('继承优先级', () => {
  it('站点默认 < 栏目 < 任务覆盖', () => {
    const site = { version: 1, list: { itemSelector: '.site' }, validate: { minTitleLength: 2 } }
    const category = { version: 1, list: { itemSelector: '.category', linkSelector: '.link' } }
    const task = { version: 1, validate: { minTitleLength: 10 } }

    const merged = mergeRuleConfigChain([site, category, task])
    expect(merged?.list?.itemSelector).toBe('.category')
    expect(merged?.list?.linkSelector).toBe('.link')
    expect(merged?.validate?.minTitleLength).toBe(10)
  })

  it('全部为空时返回 null', () => {
    expect(mergeRuleConfigChain([undefined, null])).toBeNull()
  })

  it('合并策略文案随实现导出', () => {
    expect(RULE_MERGE_STRATEGY).toContain('数组整体替换')
    expect(RULE_MERGE_STRATEGY).toContain('fields 按字段名逐层合并')
  })
})

describe('深度相等', () => {
  it('能识别对象与数组的差异', () => {
    expect(isDeepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(isDeepEqual({ a: [1] }, { a: [1, 2] })).toBe(false)
    expect(isDeepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(isDeepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
  })
})
