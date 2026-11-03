import { describe, expect, it } from 'vitest'
import { isSameArticleUrl, normalizeArticleUrl } from '../../src/shared/url-normalize.js'

describe('normalizeArticleUrl', () => {
  it('去掉营销跟踪参数并保留业务参数', () => {
    const url = normalizeArticleUrl(
      'https://News.Example.com/a/1?utm_source=wechat&id=42&utm_medium=social&from=timeline',
    )
    // 参数按 key 排序：from < id
    expect(url).toBe('https://news.example.com/a/1?from=timeline&id=42')
  })

  it('查询参数按 key 排序，参数顺序不同视为同一地址', () => {
    const left = normalizeArticleUrl('https://example.com/p?b=2&a=1&utm_campaign=x')
    const right = normalizeArticleUrl('https://example.com/p?a=1&b=2')
    expect(left).toBe(right)
    expect(isSameArticleUrl(left, right)).toBe(true)
  })

  it('去掉锚点与默认端口', () => {
    expect(normalizeArticleUrl('http://example.com:80/a#section')).toBe('http://example.com/a')
    expect(normalizeArticleUrl('https://example.com:443/a#x')).toBe('https://example.com/a')
  })

  it('保留非默认端口与末尾路径', () => {
    expect(normalizeArticleUrl('http://example.com:8080/a/')).toBe('http://example.com:8080/a/')
  })

  it('可以追加自定义剔除参数', () => {
    expect(
      normalizeArticleUrl('https://example.com/a?track=1&keep=2', { trackingParams: ['track'] }),
    ).toBe('https://example.com/a?keep=2')
  })

  it('无法解析或非 http(s) 的地址原样返回，由调用方决定丢弃', () => {
    expect(normalizeArticleUrl('not a url')).toBe('not a url')
    expect(normalizeArticleUrl('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('key 匹配大小写不敏感', () => {
    expect(normalizeArticleUrl('https://example.com/a?UTM_Source=x&id=1')).toBe(
      'https://example.com/a?id=1',
    )
  })
})
