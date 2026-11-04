import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ParserError,
  cleanHtml,
  cleanText,
  createParser,
  extractImages,
  getJsonPath,
  htmlToText,
  normalizeUrl,
} from '../../src/core/index.js'

const listHtml = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8')
const detailHtml = readFileSync(new URL('./fixtures/detail.html', import.meta.url), 'utf8')

const parser = createParser()

describe('CSS 解析', () => {
  it('按选择器提取单个文本并清洗空白', () => {
    const value = parser.extractText(listHtml, '.news-item .title')
    expect(value).toBe('第一篇报道')
  })

  it('multiple 返回全部匹配', () => {
    const values = parser.extractText(listHtml, '.news-item .title', { multiple: true })
    expect(values).toEqual(['第一篇报道', '第二篇报道', '第三篇报道', '重复的第一篇'])
  })

  it('提取属性', () => {
    const hrefs = parser.extractAttribute(listHtml, '.news-item .title', 'href', { multiple: true })
    expect(hrefs).toHaveLength(4)
    expect(hrefs[1]).toContain('/news/2.html')
  })

  it('提取列表为对象数组', () => {
    const items = parser.extractList(listHtml, '.news-item', {
      title: { type: 'text', selector: '.title' },
      time: { type: 'text', selector: '.time' },
      href: { type: 'attr', selector: '.title', attribute: 'href' },
    })

    expect(items).toHaveLength(4)
    expect(items[0]).toEqual({ title: '第一篇报道', time: '2026-01-01', href: '/news/1.html' })
  })

  it('统计匹配数量，便于规则校验', () => {
    expect(parser.count(listHtml, '.news-item')).toBe(4)
    expect(parser.count(listHtml, '.not-exist')).toBe(0)
  })

  it('非法 CSS 选择器抛出 ParserError', () => {
    expect(() => parser.count(listHtml, 'div[')).toThrow(ParserError)
  })
})

describe('字段提取：必填、默认值与嵌套', () => {
  it('必填字段缺失时标记 missing 且不写数据', () => {
    const result = parser.extractFields(listHtml, {
      title: { type: 'text', selector: '.news-item .title', required: true },
      content: { type: 'text', selector: '.article-content', required: true },
    })

    expect(result.data.title).toBe('第一篇报道')
    expect(result.missing).toEqual(['content'])
    expect(result.fields.content?.ok).toBe(false)
    expect(result.errors[0]).toContain('content')
  })

  it('缺省值在未匹配时生效', () => {
    const result = parser.extractFields(listHtml, {
      author: { type: 'text', selector: '.author', defaultValue: '佚名' },
    })
    expect(result.data.author).toBe('佚名')
    expect(result.fields.author?.ok).toBe(true)
  })

  it('嵌套 object 字段', () => {
    const result = parser.extractFields(detailHtml, {
      meta: {
        type: 'object',
        selector: '.meta',
        fields: {
          author: { type: 'text', selector: '.author' },
          publishTime: { type: 'text', selector: '.publish-time' },
        },
      },
    })

    expect(result.data.meta).toEqual({ author: '张三', publishTime: '2026-01-01 10:00' })
  })

  it('字段规则不合法时在加载阶段直接报错', () => {
    expect(() => parser.extractFields(detailHtml, { cover: { type: 'attr' } })).toThrow(ParserError)
    expect(() =>
      parser.extractFields(detailHtml, {
        box: { type: 'object' },
      }),
    ).toThrow(ParserError)
  })
})

describe('文本与 HTML 清洗', () => {
  it('折叠空白并按正则替换', () => {
    const text = cleanText('  发布 于\n\n2026-01-01  ', { collapseWhitespace: true, removePattern: '发布\\s*于' })
    expect(text).toBe('2026-01-01')
  })

  it('cleanHtml 移除脚本、样式、事件属性与危险链接', () => {
    const cleaned = cleanHtml(detailHtml, { removeSelectors: ['.ad'] })

    expect(cleaned).not.toContain('<script')
    expect(cleaned).not.toContain('<style')
    expect(cleaned).not.toContain('onclick')
    expect(cleaned).not.toContain('javascript:')
    expect(cleaned).not.toContain('这里是广告')
    expect(cleaned).toContain('第一段正文')
  })

  it('htmlToText 只保留正文文本', () => {
    const text = htmlToText(detailHtml)
    expect(text).toContain('第一段正文')
    expect(text).not.toContain('document.write')
    expect(text).not.toContain('color: red')
  })

  it('图片提取转为绝对地址并去重', () => {
    const images = extractImages(detailHtml, (value) => new URL(value, 'https://example.com/news/1.html').toString())
    expect(images).toEqual([
      'https://example.com/images/a.png',
      'https://cdn.example.com/b.png',
    ])
  })
})

describe('URL 处理', () => {
  it('相对地址转绝对地址', () => {
    expect(parser.resolveUrl('/news/1.html', 'https://example.com/list')).toBe('https://example.com/news/1.html')
  })

  it('规范化时去掉跟踪参数、fragment 并排序查询参数', () => {
    const normalized = normalizeUrl('https://Example.com:443/a?b=2&utm_source=x&a=1#top')
    expect(normalized).toBe('https://example.com/a?a=1&b=2')
  })

  it('保留业务必要参数', () => {
    const normalized = normalizeUrl('https://example.com/a?id=42&page=2')
    expect(normalized).toBe('https://example.com/a?id=42&page=2')
  })
})

describe('JSON 字段路径', () => {
  const data = {
    code: 0,
    data: {
      title: '接口标题',
      items: [{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }],
    },
  }

  it('读取嵌套字段', () => {
    expect(getJsonPath(data, 'data.title')).toBe('接口标题')
    expect(getJsonPath(data, '$.data.items[1].url')).toBe('https://example.com/2')
  })

  it('[*] 返回数组', () => {
    expect(getJsonPath(data, 'data.items[*].url')).toEqual(['https://example.com/1', 'https://example.com/2'])
  })

  it('不存在的路径返回 undefined', () => {
    expect(getJsonPath(data, 'data.nope')).toBeUndefined()
  })

  it('非法路径抛错', () => {
    expect(() => getJsonPath(data, 'data..title')).toThrow(ParserError)
  })

  it('JSON 模式下按 jsonPath 提取字段', () => {
    const result = parser.extractJsonFields(data, {
      title: { type: 'text', jsonPath: 'data.title', required: true },
      urls: { type: 'text', jsonPath: 'data.items[*].url', multiple: true },
    })

    expect(result.data).toEqual({
      title: '接口标题',
      urls: ['https://example.com/1', 'https://example.com/2'],
    })
    expect(result.missing).toEqual([])
  })
})
