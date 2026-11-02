/**
 * WebCrawler 预览注入脚本 · 第一部分：CSS Selector 生成器。
 *
 * 该文件与 preview-agent.js 一起通过 Vite `?raw` 拼接后注入 sandboxed iframe，
 * 因此必须自包含：不能 import、不能使用构建期语法，只能暴露 window.__wcGen。
 *
 * 生成优先级（任务书要求）：
 *   1. 唯一且稳定的 id
 *   2. 稳定 class 组合（避免带哈希的构建产物类名）
 *   3. 有意义的父级路径（锚点 + 相对路径）
 *   4. :nth-of-type 位置选择器兜底（避免使用脆弱的 nth-child 长路径）
 *
 * 铁律：任何候选选择器都必须在当前文档中 querySelectorAll 验证
 * 「命中数量 === 1 且包含目标元素」，不允许根据 class 字符串猜测唯一性。
 */
;(function () {
  'use strict'

  /** 构建产物类名（css-1q2w3e / sc-xxxx / MuiXxx-abc123 等）不具备稳定性。 */
  var GENERATED_CLASS = /(?:[0-9]{4,}|[a-f0-9]{6,})/

  function isStableId(id) {
    return /^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(id) && !GENERATED_CLASS.test(id)
  }

  function isStableClass(name) {
    return name.length >= 2 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && !GENERATED_CLASS.test(name)
  }

  function escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
    return value.replace(/([^a-zA-Z0-9_\u0080-\uFFFF-])/g, '\\$1')
  }

  /**
   * 在文档中验证 selector：
   * 返回命中数量（要求包含 el）；选择器非法或不包含 el 时返回 -1。
   */
  function verifiedCount(doc, el, selector) {
    try {
      var nodes = doc.querySelectorAll(selector)
      var included = false
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i] === el) {
          included = true
          break
        }
      }
      return included ? nodes.length : -1
    } catch (error) {
      return -1
    }
  }

  function classChain(el, classes) {
    var tag = el.tagName.toLowerCase()
    return classes.length > 0 ? tag + '.' + classes.map(escapeCss).join('.') : tag
  }

  function combos(items, size) {
    var result = []
    function pick(start, current) {
      if (current.length === size) {
        result.push(current.slice())
        return
      }
      for (var i = start; i < items.length; i++) {
        current.push(items[i])
        pick(i + 1, current)
        current.pop()
      }
    }
    pick(0, [])
    return result
  }

  /** 尝试用 id / class 组合生成「锚点」选择器（可唯一命中的祖先）。 */
  function anchorSelector(doc, node) {
    if (node.id && isStableId(node.id)) {
      var idSel = '#' + escapeCss(node.id)
      var nodes = doc.querySelectorAll(idSel)
      if (nodes.length === 1) return idSel
    }
    var classes = Array.prototype.slice.call(node.classList).filter(isStableClass)
    for (var size = Math.min(classes.length, 2); size >= 1; size--) {
      var candidates = combos(classes, size)
      for (var i = 0; i < candidates.length; i++) {
        var sel = classChain(node, candidates[i])
        if (doc.querySelectorAll(sel).length === 1) return sel
      }
    }
    return null
  }

  /** 从 anchor 的子层一路写到 el（不含位置信息），需整体验证。 */
  function relativeChain(el, anchor) {
    var chain = []
    var node = el
    while (node && node !== anchor) {
      var classes = Array.prototype.slice.call(node.classList).filter(isStableClass).slice(0, 2)
      chain.unshift(classChain(node, classes))
      node = node.parentElement
    }
    return chain.join(' > ')
  }

  /** 第 4 优先级：:nth-of-type 位置路径（自底向上，命中唯一即停）。 */
  function positionalPath(el) {
    var doc = el.ownerDocument
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && depth < 6) {
      var index = 1
      var sibling = node
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === node.tagName) index++
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')')
      var candidate = parts.join(' > ')
      try {
        if (doc.querySelectorAll(candidate).length === 1 && depth >= 1) return candidate
      } catch (error) {
        /* 继续向上扩展 */
      }
      node = node.parentElement
      depth++
    }
    return parts.join(' > ')
  }

  /**
   * 生成选择器。返回字符串；极端情况（元素已脱离文档）返回 null。
   */
  function generateSelector(el) {
    if (!el || el.nodeType !== 1 || !el.ownerDocument) return null
    var doc = el.ownerDocument

    // 1. 唯一且稳定的 id
    if (el.id && isStableId(el.id)) {
      var idSel = '#' + escapeCss(el.id)
      if (verifiedCount(doc, el, idSel) === 1) return idSel
    }

    // 2. 稳定 class 组合：先长组合后短组合
    var classes = Array.prototype.slice.call(el.classList).filter(isStableClass)
    var classCandidates = []
    for (var size = Math.min(classes.length, 3); size >= 1; size--) {
      classCandidates = classCandidates.concat(
        combos(classes, size).map(function (group) {
          return classChain(el, group)
        }),
      )
    }
    for (var i = 0; i < classCandidates.length; i++) {
      if (verifiedCount(doc, el, classCandidates[i]) === 1) return classCandidates[i]
    }

    // 3. 有意义的父级路径：向上寻找可唯一命中的锚点
    var node = el.parentElement
    var guarded = 0
    while (node && node !== doc.documentElement && guarded < 10) {
      var anchor = anchorSelector(doc, node)
      if (anchor) {
        var rel = relativeChain(el, node)
        if (rel) {
          var withAnchor = anchor + ' ' + rel
          if (verifiedCount(doc, el, withAnchor) === 1) return withAnchor
          var direct = anchor + ' > ' + rel
          if (verifiedCount(doc, el, direct) === 1) return direct
        }
      }
      node = node.parentElement
      guarded++
    }

    // 4. 位置选择器兜底
    return positionalPath(el)
  }

  /** 简化 DOM 路径：每层 tag + （稳定 class）+ nth-of-type。 */
  function uniquePath(el) {
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && node !== node.ownerDocument.documentElement && depth < 6) {
      var classes = Array.prototype.slice.call(node.classList).filter(isStableClass).slice(0, 2)
      var index = 1
      var sibling = node
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === node.tagName) index++
      }
      var label = node.tagName.toLowerCase()
      if (classes.length > 0) label += '.' + classes.map(escapeCss).join('.')
      if (index > 1 || node.parentElement.querySelectorAll(node.tagName.toLowerCase()).length > 1) {
        label += ':nth-of-type(' + index + ')'
      }
      parts.unshift(label)
      node = node.parentElement
      depth++
    }
    var root = el.ownerDocument.documentElement
    if (root) parts.unshift(root.tagName.toLowerCase())
    return parts.join(' > ')
  }

  /** 选中元素的描述信息（标签 / class / id / 路径 / 附近 HTML）。 */
  function describeElement(el, options) {
    var limit = (options && options.htmlLimit) || 2400
    // 预览注入脚本自己的标记（__wc-hover 等）不属于页面结构，不能出现在上报结果里
    var classes = Array.prototype.slice.call(el.classList).filter(function (name) {
      return name.indexOf('__wc-') !== 0
    })
    var html = el.outerHTML || ''
    if (html.length > limit) {
      // 优先保留开标签与开头内容，尾部用注释标记截断
      html = html.slice(0, limit) + '<!-- 已截断 -->'
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: classes,
      path: uniquePath(el),
      outerHtml: html,
    }
  }

  window.__wcGen = {
    generateSelector: generateSelector,
    describeElement: describeElement,
    uniquePath: uniquePath,
    isStableClass: isStableClass,
  }
})()
