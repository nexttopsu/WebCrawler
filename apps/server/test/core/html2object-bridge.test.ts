import { describe, expect, it } from 'vitest'
import type { FieldRule } from '../../src/shared/index.js'
import { extractFieldsViaHtml2Object, extractListItems } from '../../src/core/parser/html2object-bridge.js'

const html = `<html><body>
  <ul class="news">
    <li class="item"><a class="t" href="/news/1.html">第一条</a><img class="c" src="/img/1.png" /><span class="tag">置顶</span></li>
    <li class="item"><a class="t" href="/news/2.html">第二条</a><img class="c" src="/img/2.png" /></li>
  </ul>
  <article>
    <h1 class="article-title">标题文本</h1>
    <div class="article-content"><p>第一段</p><p>第二段</p></div>
    <a class="origin" href="https://source.example.com/origin">来源</a>
    <span class="empty"></span>
  </article>
</body></html>`

describe('html2object 桥接：字段提取', () => {
  it('text / html / attr 三种提取类型', () => {
    const rules: Record<string, FieldRule> = {
      title: { type: 'text', selector: '.article-title' },
      content: { type: 'html', selector: '.article-content' },
      sourceUrl: { type: 'attr', selector: '.origin', attribute: 'href' },
    }
    const result = extractFieldsViaHtml2Object(html, rules)

    expect(result.errors).toEqual([])
    expect(result.data.title).toBe('标题文本')
    expect(result.data.content).toContain('<p>第一段</p>')
    expect(result.data.sourceUrl).toBe('https://source.example.com/origin')
  })

  it('未命中返回空并标记缺失，required 参与诊断', () => {
    const result = extractFieldsViaHtml2Object(html, {
      missing: { type: 'text', selector: '.not-exist', required: true },
      optional: { type: 'text', selector: '.also-not-exist' },
    })

    expect(result.missing).toEqual(['missing'])
    expect(result.fields.missing?.ok).toBe(false)
    expect(result.fields.optional?.ok).toBe(true)
    expect(result.data.optional).toBeUndefined()
  })

  it('缺失时应用默认值', () => {
    const result = extractFieldsViaHtml2Object(html, {
      author: { type: 'text', selector: '.not-exist', defaultValue: '佚名' },
    })
    expect(result.data.author).toBe('佚名')
    expect(result.fields.author?.ok).toBe(true)
  })

  it('multiple 通过 loop 提取多值', () => {
    const result = extractFieldsViaHtml2Object(html, {
      images: { type: 'attr', selector: '.article-content img', attribute: 'src', multiple: true },
      listImages: { type: 'attr', selector: 'li.item img.c', attribute: 'src', multiple: true },
    })
    expect(result.data.listImages).toEqual(['/img/1.png', '/img/2.png'])
  })

  it('jsonPath 字段回退到内置提取器（HTML 模式下报错）', () => {
    const result = extractFieldsViaHtml2Object(html, {
      bad: { type: 'text', jsonPath: 'data.title' },
      title: { type: 'text', selector: '.article-title' },
    })
    expect(result.data.title).toBe('标题文本')
    expect(result.errors.join()).toContain('jsonPath')
  })

  it('object 嵌套字段按子 schema 提取', () => {
    const result = extractFieldsViaHtml2Object(html, {
      card: {
        type: 'object',
        selector: '.article-content',
        fields: { text: { type: 'text', selector: 'p' } },
      },
    })
    expect(result.data.card).toMatchObject({ text: '第一段' })
  })
})

describe('html2object 桥接：列表项提取', () => {
  it('loop 一次解析全部列表项，字段配置生效', () => {
    const items = extractListItems(html, 'li.item', 'css', {
      title: { type: 'text', selector: 'a.t', required: true },
      url: { type: 'attr', selector: 'a.t', attribute: 'href', required: true },
      cover: { type: 'attr', selector: 'img.c', attribute: 'src' },
      tag: { type: 'text', selector: 'span.tag', defaultValue: '' },
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ title: '第一条', url: '/news/1.html', cover: '/img/1.png', tag: '置顶' })
    expect(items[1]).toMatchObject({ title: '第二条', url: '/news/2.html' })
  })

  it('XPath 容器回退到内置提取器', () => {
    const items = extractListItems(html, '//li[@class="item"]', 'xpath', {
      title: { type: 'text', selector: 'a.t' },
      url: { type: 'attr', selector: 'a.t', attribute: 'href' },
    })
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ title: '第二条', url: '/news/2.html' })
  })
})
