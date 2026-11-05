import { describe, expect, it } from 'vitest'
import {
  checkPagination,
  createDefaultRuleConfig,
  formatRuleIssues,
  parseRuleConfig,
  RULE_SCHEMA_VERSION,
} from '../../src/shared/index.js'

/** 任务书里的示例规则，必须能通过校验。 */
const exampleConfig = {
  version: 1,
  request: {
    mode: 'http',
    method: 'GET',
    timeout: 15000,
  },
  list: {
    url: 'https://example.com/news',
    itemSelector: '.news-item',
    linkSelector: 'a',
    pagination: {
      type: 'query',
      parameter: 'page',
      start: 1,
      maxPages: 10,
    },
  },
  detail: {
    fields: {
      title: { selector: 'h1', type: 'text', required: true },
      content: { selector: '.article-content', type: 'html' },
      publishTime: { selector: '.publish-time', type: 'text' },
      images: {
        selector: '.article-content img',
        type: 'attr',
        attribute: 'src',
        multiple: true,
      },
    },
  },
}

function errorText(input: unknown): string {
  const result = parseRuleConfig(input)
  expect(result.success).toBe(false)
  return result.success ? '' : formatRuleIssues(result.issues)
}

describe('规则 Schema', () => {
  it('任务书示例配置通过校验，并保留字段定义', () => {
    const result = parseRuleConfig(exampleConfig)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.config.version).toBe(RULE_SCHEMA_VERSION)
    expect(result.config.list?.itemSelector).toBe('.news-item')
    expect(result.config.list?.pagination?.type).toBe('query')
    expect(result.config.detail?.fields?.images).toMatchObject({
      type: 'attr',
      attribute: 'src',
      multiple: true,
    })
  })

  it('版本号必须是受支持的结构版本', () => {
    expect(errorText({ version: 2 })).toContain('规则结构版本仅支持 1')
    expect(errorText({})).toContain('version')
  })

  it('未知字段直接报错，不会被静默忽略', () => {
    expect(errorText({ version: 1, itemSelector: '.x' })).toContain('Unrecognized key')
  })

  it('attr 类型缺少 attribute 时报错', () => {
    const text = errorText({
      version: 1,
      detail: { fields: { cover: { type: 'attr', selector: 'img' } } },
    })
    expect(text).toContain('attribute')
  })

  it('list 类型缺少 fields 时报错', () => {
    const text = errorText({
      version: 1,
      detail: { fields: { tags: { type: 'list', selector: '.tag' } } },
    })
    expect(text).toContain('fields')
  })

  it('文本字段缺少 selector 时报错', () => {
    const text = errorText({ version: 1, detail: { fields: { title: { type: 'text' } } } })
    expect(text).toContain('selector')
  })

  it('字段名必须是标识符', () => {
    const text = errorText({
      version: 1,
      detail: { fields: { '标题': { type: 'text', selector: 'h1' } } },
    })
    expect(text).toContain('字段名')
  })

  it('请求头禁止换行符，防止头注入', () => {
    const text = errorText({ version: 1, request: { headers: { 'x-test': 'a\r\nb' } } })
    expect(text).toContain('换行符')
  })

  it('代理只支持 http / https', () => {
    const text = errorText({
      version: 1,
      request: { proxy: { protocol: 'socks5', host: '127.0.0.1', port: 1080 } },
    })
    expect(text).toContain('代理协议')
  })

  it('采集范围只接受 list / full', () => {
    const text = errorText({ version: 1, collectScope: 'detail-only' })
    expect(text).toContain('采集范围')
  })

  it('采集范围为仅列表时必须配置 list', () => {
    const text = errorText({ version: 1, collectScope: 'list' })
    expect(text).toContain('必须配置 list 规则')
  })

  it('采集范围为仅列表且配置了 list 时通过校验', () => {
    const result = parseRuleConfig({
      version: 1,
      collectScope: 'list',
      list: { itemSelector: '.news-item', pagination: { type: 'none' } },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.config.collectScope).toBe('list')
  })

  it('request.mode 与 browser.enabled 不能冲突', () => {
    const text = errorText({ version: 1, request: { mode: 'http' }, browser: { enabled: true } })
    expect(text).toContain('冲突')
  })

  it('字段嵌套深度受限', () => {
    let rule: Record<string, unknown> = { type: 'text', selector: 'span' }
    for (let i = 0; i < 10; i += 1) {
      rule = { type: 'object', fields: { child: rule } }
    }
    const text = errorText({ version: 1, detail: { fields: { deep: rule } } })
    expect(text).toContain('嵌套深度')
  })

  it('字段映射只能放在 detail.fields 或顶层 fields 其中之一', () => {
    const text = errorText({
      version: 1,
      fields: { title: { type: 'text', selector: 'h1' } },
      detail: { fields: { content: { type: 'html', selector: '.c' } } },
    })
    expect(text).toContain('其中之一')
  })
})

describe('分页校验', () => {
  it('query 分页必须提供参数名', () => {
    const text = errorText({
      version: 1,
      list: { itemSelector: '.item', pagination: { type: 'query' } },
    })
    expect(text).toContain('parameter')
  })

  it('path 分页必须包含 {page} 占位符', () => {
    expect(
      checkPagination({ type: 'path', pathPattern: '/news/page' }),
    ).toEqual(['path 分页的 pathPattern 必须包含 {page} 占位符'])

    expect(checkPagination({ type: 'path', pathPattern: '/news/page/{page}' })).toEqual([])
  })

  it('next / cursor 第一版明确报错，而不是静默忽略', () => {
    const nextErrors = checkPagination({ type: 'next', nextSelector: '.next' })
    expect(nextErrors).toHaveLength(1)
    expect(nextErrors[0]).toContain('尚未实现')

    const cursorErrors = checkPagination({ type: 'cursor', cursorParameter: 'cursor' })
    expect(cursorErrors[0]).toContain('尚未实现')

    expect(
      errorText({ version: 1, list: { itemSelector: '.item', pagination: { type: 'next', nextSelector: '.next' } } }),
    ).toContain('尚未实现')
  })

  it('未设置分页时返回空错误列表', () => {
    expect(checkPagination(undefined)).toEqual([])
  })

  it('list.pagination 与顶层 pagination 不允许不同值', () => {
    const text = errorText({
      version: 1,
      list: { itemSelector: '.item', pagination: { type: 'query', parameter: 'page' } },
      pagination: { type: 'none' },
    })
    expect(text).toContain('不能同时设置不同的值')
  })

  it('list.pagination 与顶层 pagination 相同时允许', () => {
    const result = parseRuleConfig({
      version: 1,
      list: { itemSelector: '.item', pagination: { type: 'none' } },
      pagination: { type: 'none' },
    })
    expect(result.success).toBe(true)
  })
})

describe('默认规则', () => {
  it('默认配置本身是合法的', () => {
    const result = parseRuleConfig(createDefaultRuleConfig())
    expect(result.success).toBe(true)
  })
})

describe('规则 Schema：全流程插件', () => {
  it('列表只配插件、不写抽取规则也能通过（分页仍可配置）', () => {
    const result = parseRuleConfig({
      version: 1,
      list: { plugin: 'example-flow-news', pagination: { type: 'query', parameter: 'page' } },
      detail: { plugin: 'example-flow-news' },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.config.list?.plugin).toBe('example-flow-news')
    expect(result.config.list?.pagination?.type).toBe('query')
    expect(result.config.detail?.plugin).toBe('example-flow-news')
  })

  it('没有插件时必须提供 itemSelector', () => {
    const text = errorText({ version: 1, list: { linkSelector: 'a' } })
    expect(text).toContain('itemSelector')
  })

  it('列表插件与 linkSelector / titleSelector 互斥', () => {
    expect(errorText({ version: 1, list: { plugin: 'p', linkSelector: 'a' } })).toContain('不能同时使用')
    expect(errorText({ version: 1, list: { plugin: 'p', titleSelector: '.t' } })).toContain('不能同时使用')
  })

  it('详情插件与字段映射互斥', () => {
    const text = errorText({
      version: 1,
      list: { itemSelector: '.item' },
      detail: { plugin: 'p', fields: { title: { type: 'text', selector: 'h1' } } },
    })
    expect(text).toContain('二选一')
  })

  it('插件 id 不合法时报错', () => {
    expect(errorText({ version: 1, list: { plugin: '插件 名' } })).toContain('插件 id 不合法')
  })
})
