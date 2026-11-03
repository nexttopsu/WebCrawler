// @vitest-environment happy-dom
/**
 * Selector 生成器测试。
 *
 * 直接执行 `src/preview/selector-generator.js` 的源码（与注入 iframe 的完全一致），
 * 用 happy-dom 提供真实 DOM —— 保证「生成结果必须在文档中验证」这条规则被真正执行。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import generatorSource from '../src/preview/selector-generator.js?raw'

interface GeneratorApi {
  generateSelector(el: Element): string | null
  describeElement(el: Element, options?: { htmlLimit?: number }): {
    tag: string
    id: string | null
    classes: string[]
    path: string
    outerHtml: string
  }
  uniquePath(el: Element): string
}

let api: GeneratorApi

/** 在独立 window 上执行生成器脚本，返回其暴露的 API。 */
function loadGenerator(): GeneratorApi {
  const factory = new Function('window', 'document', `${generatorSource}\nreturn window.__wcGen`)
  return factory(window, document) as GeneratorApi
}

beforeEach(() => {
  document.body.innerHTML = ''
  api = loadGenerator()
})

describe('SelectorGenerator：优先级', () => {
  it('优先使用稳定且唯一的 id', () => {
    document.body.innerHTML = '<div class="wrap"><span id="main-content" class="x">a</span></div>'
    const el = document.querySelector('.x')!
    expect(api.generateSelector(el)).toBe('#main-content')
  })

  it('id 不唯一时退回 class 组合', () => {
    document.body.innerHTML =
      '<div id="dup"></div><div id="dup"><p class="article-title">标题</p></div>'
    const el = document.querySelector('.article-title')!
    expect(api.generateSelector(el)).toBe('p.article-title')
  })

  it('class 组合有多匹配时使用父级路径', () => {
    document.body.innerHTML = `
      <div class="list-a"><div class="item"><a class="title" href="/1">一</a></div></div>
      <div class="list-b"><div class="item"><a class="title" href="/2">二</a></div></div>`
    const el = document.querySelectorAll('.list-b .title')[0]!
    const selector = api.generateSelector(el)!
    expect(selector).toContain('list-b')
    expect(document.querySelectorAll(selector)).toHaveLength(1)
    expect(document.querySelector(selector)).toBe(el)
  })

  it('没有可用 class 时用 :nth-of-type 兜底，并验证唯一', () => {
    document.body.innerHTML = '<ul><li>一</li><li>二</li><li>三</li></ul>'
    const el = document.querySelectorAll('li')[1]!
    const selector = api.generateSelector(el)!
    expect(selector).toContain('nth-of-type')
    expect(document.querySelectorAll(selector)).toHaveLength(1)
    expect(document.querySelector(selector)).toBe(el)
  })

  it('忽略构建产物风格的哈希 class', () => {
    document.body.innerHTML = '<div class="css-1q2w3e4r"><span class="text">a</span></div>'
    const el = document.querySelector('span')!
    const selector = api.generateSelector(el)!
    expect(selector).not.toContain('css-1q2w3e4r')
    expect(document.querySelectorAll(selector)).toHaveLength(1)
  })

  it('生成的选择器总是能在当前文档中唯一定位目标元素', () => {
    document.body.innerHTML = `
      <section><div><div><article><h2>标题</h2><p class="lead">导语</p></article></div></div></section>`
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const selector = api.generateSelector(el)
      if (!selector) continue
      expect(document.querySelector(selector)).toBe(el)
    }
  })
})

describe('SelectorGenerator：元素描述', () => {
  it('返回标签、id、class、路径与截断的 HTML', () => {
    document.body.innerHTML = '<div class="wrap"><a id="link-1" class="btn primary" href="/x">点击</a></div>'
    const el = document.querySelector('a')!
    const info = api.describeElement(el, { htmlLimit: 20 })
    expect(info.tag).toBe('a')
    expect(info.id).toBe('link-1')
    expect(info.classes).toEqual(['btn', 'primary'])
    expect(info.path).toContain('a')
    expect(info.outerHtml.length).toBeLessThanOrEqual(40)
    expect(info.outerHtml).toContain('已截断')
  })
})
