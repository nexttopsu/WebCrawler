/**
 * WebCrawler 预览注入脚本 · 第二部分：预览代理。
 *
 * 运行在 sandboxed iframe（无 allow-same-origin）里：
 * - iframe 处于 opaque origin，读不到管理后台的 cookie / localStorage / DOM；
 * - 目标页面的脚本已在服务端清洗时移除，这里只提供「点选」交互；
 * - 所有出站消息都带 source 标识，父页面必须校验 event.source 与 source 字段；
 * - 捕获阶段拦截所有点击与表单提交，预览页不允许任意导航。
 *
 * 与父页面的完整协议见 packages/shared/src/tester.ts。
 */
;(function () {
  'use strict'

  var SOURCE = 'webcrawler-preview'
  var gen = window.__wcGen

  var HOVER_CLASS = '__wc-hover'
  var HIGHLIGHT_CLASS = '__wc-highlight'
  var highlightedNodes = []

  var style = document.createElement('style')
  style.textContent =
    '.' + HOVER_CLASS + ' { outline: 2px dashed #2f6bff !important; outline-offset: -2px !important; cursor: crosshair !important; }' +
    '.' + HIGHLIGHT_CLASS + ' { outline: 2px solid #2f6bff !important; outline-offset: -2px !important; background: rgba(47, 107, 255, 0.12) !important; }' +
    '.__wc-selected { outline: 2px solid #12b76a !important; outline-offset: -2px !important; background: rgba(18, 183, 106, 0.10) !important; }'
  document.head.appendChild(style)

  function post(message) {
    message.source = SOURCE
    try {
      window.parent.postMessage(message, '*')
    } catch (error) {
      /* parent 不可达时静默：sandbox 环境下不应中断预览 */
    }
  }

  function clearMarks(className) {
    var nodes = document.querySelectorAll('.' + className)
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove(className)
  }

  function clearHighlight() {
    for (var i = 0; i < highlightedNodes.length; i++) {
      highlightedNodes[i].classList.remove(HIGHLIGHT_CLASS)
    }
    highlightedNodes = []
  }

  /* ------------------------------ 悬停与点选 ------------------------------ */

  var interactive = /^(a|button|input|select|textarea|label)$/i

  document.addEventListener(
    'mouseover',
    function (event) {
      var target = event.target
      if (!(target instanceof Element) || target.closest('style')) return
      clearMarks(HOVER_CLASS)
      target.classList.add(HOVER_CLASS)
    },
    true,
  )

  document.addEventListener(
    'mouseout',
    function () {
      clearMarks(HOVER_CLASS)
    },
    true,
  )

  document.addEventListener(
    'click',
    function (event) {
      // 预览页不允许导航：拦截一切点击的默认行为
      event.preventDefault()
      event.stopPropagation()

      var target = event.target
      if (!(target instanceof Element)) return
      var selectable = target.closest('a,button,input,select,textarea,label')
      if (selectable && interactive.test(selectable.tagName)) {
        // 表单控件与链接本身也可以被选中，但同样不触发默认行为
      }

      // 预览内部标记（hover / selected）不能进入生成结果与上报数据
      clearMarks(HOVER_CLASS)
      clearMarks('__wc-selected')

      var selector = gen.generateSelector(target)
      if (!selector) return
      var matchCount
      try {
        matchCount = document.querySelectorAll(selector).length
      } catch (error) {
        matchCount = 0
      }
      // 先取描述再打标记：选中态 class 不能混进上报的 classes / outerHtml
      var described = gen.describeElement(target)

      target.classList.add('__wc-selected')

      post({
        type: 'selected',
        selector: selector,
        matchCount: matchCount,
        tag: described.tag,
        id: described.id,
        classes: described.classes,
        path: described.path,
        outerHtml: described.outerHtml,
      })
    },
    true,
  )

  // 阻止表单提交、键盘回车导航等一切改变页面位置的行为
  document.addEventListener('submit', function (event) { event.preventDefault() }, true)
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') event.preventDefault()
  }, true)

  /* ------------------------------ 父页面指令 ------------------------------ */

  window.addEventListener('message', function (event) {
    var payload = event.data
    if (!payload || typeof payload !== 'object' || payload.source !== SOURCE) return

    if (payload.type === 'clear') {
      clearHighlight()
      clearMarks('__wc-selected')
      return
    }

    if (payload.type === 'highlight') {
      clearHighlight()
      var selector = payload.selector
      if (!selector || typeof selector !== 'string') {
        post({ type: 'highlight-result', selector: '', matchCount: 0, error: '选择器为空' })
        return
      }
      if (payload.selectorType === 'xpath') {
        post({
          type: 'highlight-result',
          selector: selector,
          matchCount: 0,
          error: '预览内仅支持 CSS 选择器校验，XPath 请使用「在服务端验证」',
        })
        return
      }
      var nodes
      try {
        nodes = document.querySelectorAll(selector)
      } catch (error) {
        post({ type: 'highlight-result', selector: selector, matchCount: 0, error: '选择器语法不合法' })
        return
      }
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.add(HIGHLIGHT_CLASS)
        highlightedNodes.push(nodes[i])
      }
      post({ type: 'highlight-result', selector: selector, matchCount: nodes.length })
    }
  })

  post({ type: 'ready' })
})()
