// @vitest-environment happy-dom
/**
 * 预览代理测试。
 *
 * 执行与注入 iframe 完全相同的两段脚本，模拟：
 * - 点选元素 → 生成选择器并通过 postMessage 上报；
 * - 悬停高亮；
 * - 父页面下发 highlight 指令 → 在真实 DOM 中高亮并回报匹配数；
 * - 点击链接不导航（默认行为被拦截）；
 * - 伪造 source 的消息被忽略。
 *
 * 每个用例使用独立的 happy-dom Window：代理脚本会向 document 注册捕获阶段监听，
 * 复用同一个 document 会让上一个用例的监听继续生效（选择器与选中态互相污染）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import generatorSource from '../src/preview/selector-generator.js?raw'
import agentSource from '../src/preview/preview-agent.js?raw'

interface AgentHarness {
  win: Window
  doc: Document
  messages: Array<Record<string, unknown>>
  send: (payload: unknown) => void
}

let harness: AgentHarness

function loadAgent(): AgentHarness {
  const win = new Window({ url: 'https://preview.invalid/' })
  const doc = win.document
  doc.body.innerHTML = ''

  const messages: Array<Record<string, unknown>> = []
  const handlers: Record<string, Array<(event: unknown) => void>> = {}

  const fakeWindow = {
    parent: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      ;(handlers[type] ??= []).push(handler)
    },
    CSS: win.CSS,
  }

  const factory = new Function(
    'window',
    'document',
    'Element',
    `${generatorSource}\n${agentSource}`,
  )
  factory(fakeWindow, doc, win.Element)

  return {
    win,
    doc,
    messages,
    send: (payload: unknown) => {
      for (const handler of handlers.message ?? []) {
        handler({ data: payload, source: fakeWindow })
      }
    },
  }
}

beforeEach(() => {
  harness = loadAgent()
})

describe('preview-agent：初始化与点选', () => {
  it('初始化完成后上报 ready', () => {
    expect(harness.messages[0]).toEqual({ source: 'webcrawler-preview', type: 'ready' })
  })

  it('点击元素后生成选择器并上报元素信息', () => {
    harness.doc.body.innerHTML = `
      <div class="news-list">
        <div class="news-item"><a class="title" href="/article/1">第一篇</a></div>
      </div>`
    const link = harness.doc.querySelector('.title')!
    const click = new harness.win.MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)

    const selected = harness.messages.find((message) => message.type === 'selected')
    expect(selected).toBeTruthy()
    expect(selected!.selector).toBe('a.title')
    expect(selected!.matchCount).toBe(1)
    expect(selected!.tag).toBe('a')
    // 选中态 class 属于预览内部标记，不能污染上报的 class 与 HTML
    expect(selected!.classes).toEqual(['title'])
    expect(String(selected!.outerHtml)).not.toContain('__wc-selected')
    expect(selected!.path).toContain('div.news-item')
    expect(String(selected!.outerHtml)).toContain('href="/article/1"')

    // 预览中点击不允许导航
    expect(click.defaultPrevented).toBe(true)
  })

  it('悬停时给元素加高亮 class，移出后移除', () => {
    harness.doc.body.innerHTML = '<div class="item">x</div>'
    const item = harness.doc.querySelector('.item')!
    item.dispatchEvent(new harness.win.MouseEvent('mouseover', { bubbles: true }))
    expect(item.classList.contains('__wc-hover')).toBe(true)

    item.dispatchEvent(new harness.win.MouseEvent('mouseout', { bubbles: true }))
    expect(item.classList.contains('__wc-hover')).toBe(false)
  })
})

describe('preview-agent：父页面指令', () => {
  it('highlight 指令在真实 DOM 中高亮所有匹配并回报数量', () => {
    harness.doc.body.innerHTML = `
      <div class="news-item">一</div>
      <div class="news-item">二</div>
      <div class="other">三</div>`

    harness.send({ source: 'webcrawler-preview', type: 'highlight', selector: '.news-item' })

    const result = harness.messages.find((message) => message.type === 'highlight-result')
    expect(result).toMatchObject({ selector: '.news-item', matchCount: 2 })
    expect(harness.doc.querySelectorAll('.__wc-highlight')).toHaveLength(2)

    harness.send({ source: 'webcrawler-preview', type: 'clear' })
    expect(harness.doc.querySelectorAll('.__wc-highlight')).toHaveLength(0)
  })

  it('非法选择器返回错误而不是抛异常', () => {
    harness.doc.body.innerHTML = '<div></div>'
    harness.send({ source: 'webcrawler-preview', type: 'highlight', selector: 'div[' })
    const result = harness.messages.find((message) => message.type === 'highlight-result')
    expect(result!.matchCount).toBe(0)
    expect(String(result!.error)).toContain('不合法')
  })

  it('XPath 在预览内明确提示改用服务端验证', () => {
    harness.send({
      source: 'webcrawler-preview',
      type: 'highlight',
      selector: '//div',
      selectorType: 'xpath',
    })
    const result = harness.messages.find((message) => message.type === 'highlight-result')
    expect(String(result!.error)).toContain('服务端')
  })

  it('来源不匹配的消息被忽略（防止第三方窗口伪造指令）', () => {
    harness.doc.body.innerHTML = '<div class="news-item">一</div>'
    harness.send({ source: 'evil-origin', type: 'highlight', selector: '.news-item' })
    expect(harness.doc.querySelectorAll('.__wc-highlight')).toHaveLength(0)
    expect(harness.messages.some((message) => message.type === 'highlight-result')).toBe(false)
  })

  it('表单提交被拦截，页面不会跳转', () => {
    harness.doc.body.innerHTML = '<form action="/submit"><input name="q" /></form>'
    const form = harness.doc.querySelector('form')!
    const submit = new harness.win.Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(submit)
    expect(submit.defaultPrevented).toBe(true)
  })
})
