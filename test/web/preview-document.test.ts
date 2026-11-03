// @vitest-environment happy-dom
/**
 * 预览文档装配与草稿存储测试。
 *
 * - buildPreviewDocument：注入脚本位置、`</script>` 转义；
 * - 草稿：容量上限、损坏数据、版本不符、无敏感字段。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildPreviewDocument } from '../../web/src/preview/agent-source'
import {
  DRAFT_MAX_BYTES,
  clearTesterDraft,
  createEmptyDraft,
  loadTesterDraft,
  saveTesterDraft,
} from '../../web/src/composables/useTesterDraft'

describe('buildPreviewDocument', () => {
  it('把注入脚本放到 </body> 之前', () => {
    const html = '<!doctype html><html><body><h1>标题</h1></body></html>'
    const output = buildPreviewDocument(html, 'window.__agent = 1')
    expect(output.indexOf('window.__agent = 1')).toBeLessThan(output.indexOf('</body>'))
    expect(output).toContain('<h1>标题</h1>')
  })

  it('没有 body 时直接追加，不破坏原文档', () => {
    const output = buildPreviewDocument('<div>片段</div>', 'x()')
    expect(output.startsWith('<div>片段</div>')).toBe(true)
    expect(output).toContain('<script>x()</script>')
  })

  it('注入代码中的 </script> 被转义，不会提前闭合标签', () => {
    const output = buildPreviewDocument('<html><body></body></html>', 'var s = "</script>"')
    expect(output).not.toContain('"</script>"')
    expect(output).toContain('<\\/script>')
  })
})

describe('测试器草稿', () => {
  beforeEach(() => {
    clearTesterDraft()
  })

  it('保存后可完整读回', () => {
    const draft = createEmptyDraft()
    draft.url = 'https://example.com/news'
    draft.mode = 'browser'
    draft.list.itemSelector = '.news-item'
    draft.fields = [
      {
        key: 'title',
        label: '标题',
        selector: 'h1',
        type: 'text',
        attribute: '',
        multiple: false,
        required: true,
        defaultValue: '',
        trim: true,
        collapseWhitespace: false,
        enabled: true,
      },
    ]

    expect(saveTesterDraft(draft)).toEqual({ ok: true })
    const restored = loadTesterDraft()
    expect(restored?.url).toBe('https://example.com/news')
    expect(restored?.mode).toBe('browser')
    expect(restored?.list.itemSelector).toBe('.news-item')
    expect(restored?.fields[0]?.key).toBe('title')
  })

  it('超过容量上限时拒绝保存并给出原因（不静默丢数据）', () => {
    const draft = createEmptyDraft()
    // 直接构造一个超过上限的草稿：UTF-16 计量下 DRAFT_MAX_BYTES 字符即已翻倍超限
    draft.fields = [
      {
        key: 'huge',
        label: 'x'.repeat(DRAFT_MAX_BYTES),
        selector: '.x',
        type: 'text' as const,
        attribute: '',
        multiple: false,
        required: false,
        defaultValue: '',
        trim: true,
        collapseWhitespace: false,
        enabled: true,
      },
    ]

    const result = saveTesterDraft(draft)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain(`${Math.round(DRAFT_MAX_BYTES / 1024)} KB`)
    expect(loadTesterDraft()).toBeNull()
  })

  it('损坏或版本不符的草稿按「无草稿」处理', () => {
    localStorage.setItem('webcrawler.tester-draft', '{not-json')
    expect(loadTesterDraft()).toBeNull()

    localStorage.setItem('webcrawler.tester-draft', JSON.stringify({ version: 999, url: 'x' }))
    expect(loadTesterDraft()).toBeNull()
  })

  it('草稿不包含任何代理凭据字段', () => {
    const draft = createEmptyDraft()
    draft.proxyId = 3
    saveTesterDraft(draft)
    const raw = localStorage.getItem('webcrawler.tester-draft') ?? ''
    expect(raw).toContain('proxyId')
    expect(raw).not.toMatch(/password|username|secret/i)
  })
})
