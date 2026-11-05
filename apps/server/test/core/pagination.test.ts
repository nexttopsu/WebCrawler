import { describe, expect, it } from 'vitest'
import {
  buildPageUrl,
  buildPageUrlRange,
  buildPageUrls,
  PaginationError,
} from '../../src/core/task/pagination.js'

describe('分页地址生成', () => {
  it('none：只有第一页', () => {
    expect(buildPageUrl('https://example.com/news', { type: 'none' }, 1)).toBe(
      'https://example.com/news',
    )
    expect(buildPageUrl('https://example.com/news', { type: 'none' }, 2)).toBeNull()
  })

  it('query：按参数名与起始页码生成，保留原有查询参数', () => {
    const url = 'https://example.com/news?cat=1'
    expect(buildPageUrl(url, { type: 'query', parameter: 'page', start: 1 }, 1)).toBe(
      'https://example.com/news?cat=1&page=1',
    )
    expect(buildPageUrl(url, { type: 'query', parameter: 'p', start: 0 }, 3)).toBe(
      'https://example.com/news?cat=1&p=2',
    )
  })

  it('path：相对模板按列表页解析，并与列表页同源', () => {
    const url = 'https://example.com/news/index.html'
    expect(buildPageUrl(url, { type: 'path', pathPattern: '/news/page/{page}' }, 2)).toBe(
      'https://example.com/news/page/2',
    )
  })

  it('path：跨域模板直接拒绝', () => {
    expect(() =>
      buildPageUrl('https://example.com/news', { type: 'path', pathPattern: 'https://evil.com/{page}' }, 2),
    ).toThrow(PaginationError)
  })

  it('path：缺少模板或占位符时报错，不静默当单页', () => {
    expect(() => buildPageUrl('https://example.com/news', { type: 'path' }, 2)).toThrow('pathPattern')
    expect(() =>
      buildPageUrl('https://example.com/news', { type: 'path', pathPattern: '/page/2' }, 2),
    ).toThrow('{page}')
  })

  it('next / cursor 明确报「尚未实现」', () => {
    expect(() =>
      buildPageUrl('https://example.com/news', { type: 'next', nextSelector: '.next' }, 1),
    ).toThrow('尚未实现')
    expect(() =>
      buildPageUrl('https://example.com/news', { type: 'cursor', cursorParameter: 'cursor' }, 1),
    ).toThrow('尚未实现')
  })

  it('buildPageUrls 按 maxPages 截断，遇到 null 停止', () => {
    expect(buildPageUrls('https://example.com/news', { type: 'query' }, 3)).toEqual([
      'https://example.com/news?page=1',
      'https://example.com/news?page=2',
      'https://example.com/news?page=3',
    ])
    expect(buildPageUrls('https://example.com/news', { type: 'none' }, 5)).toHaveLength(1)
  })

  it('buildPageUrlRange 只生成区间内的页码', () => {
    expect(
      buildPageUrlRange('https://example.com/news', { type: 'query' }, 2, 4),
    ).toEqual([
      'https://example.com/news?page=2',
      'https://example.com/news?page=3',
      'https://example.com/news?page=4',
    ])
  })

  it('buildPageUrlRange：endPage 小于 startPage 时收敛为单页', () => {
    expect(
      buildPageUrlRange('https://example.com/news', { type: 'query' }, 3, 1),
    ).toEqual(['https://example.com/news?page=3'])
  })

  it('buildPageUrlRange：none 分页不含第 1 页时返回空数组', () => {
    expect(buildPageUrlRange('https://example.com/news', { type: 'none' }, 2, 5)).toEqual([])
    expect(buildPageUrlRange('https://example.com/news', { type: 'none' }, 1, 5)).toEqual([
      'https://example.com/news',
    ])
  })

  it('buildPageUrlRange：path 模板按区间页码替换', () => {
    expect(
      buildPageUrlRange(
        'https://example.com/news/index.html',
        { type: 'path', pathPattern: '/news/page/{page}' },
        3,
        4,
      ),
    ).toEqual([
      'https://example.com/news/page/3',
      'https://example.com/news/page/4',
    ])
  })
})
