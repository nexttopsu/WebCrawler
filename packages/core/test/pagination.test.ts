import { describe, expect, it } from 'vitest'
import {
  buildPageUrl,
  buildPageUrls,
  PaginationError,
  resolveMaxPages,
} from '../src/task/pagination.js'

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

  it('resolveMaxPages 优先使用任务覆盖值', () => {
    expect(resolveMaxPages(undefined)).toBe(1)
    expect(resolveMaxPages({ type: 'query', maxPages: 5 })).toBe(5)
    expect(resolveMaxPages({ type: 'query', maxPages: 5 }, 2)).toBe(2)
    expect(resolveMaxPages({ type: 'query', maxPages: 0 })).toBe(1)
  })
})
