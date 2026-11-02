/**
 * 浏览器端二次清洗 HTML。
 *
 * 服务端落库前已经清洗过一遍（去脚本、去事件属性、图片转绝对地址），
 * 但前端渲染 `v-html` 是最后一道防线：历史数据、手工导入的 JSON、
 * 被换过的插件都可能带来没经过服务端管道的 HTML，这里再收一次。
 *
 * 只做「删掉危险节点与属性」，不做美化，避免改变正文观感。
 */

/** 直接连内容一起丢弃的标签。 */
const DROP_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
])

/** 允许保留的标签；不在白名单内的一律拆成文本。 */
const ALLOW_TAGS = new Set([
  'a', 'abbr', 'article', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
  'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

/** 允许保留的属性（`data-*` 单独放行）。 */
const ALLOW_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'class', 'style',
  'srcset', 'sizes', 'loading', 'target', 'rel', 'align',
])

const SAFE_PROTOCOL = /^(https?:|mailto:|tel:|\/|#|data:image\/)/i

function sanitizeUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // 显式拦掉 javascript: / vbscript: 这类伪协议
  if (/^(javascript|vbscript|file):/i.test(trimmed.replace(/[\s\u0000-\u001f]/g, ''))) return null
  if (!SAFE_PROTOCOL.test(trimmed)) return null
  return trimmed
}

function cleanNode(node: Element): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase()

    if (DROP_TAGS.has(tag)) {
      child.remove()
      continue
    }

    if (!ALLOW_TAGS.has(tag)) {
      // 未知标签：保留文字，去掉标签本身
      const text = document.createTextNode(child.textContent ?? '')
      child.replaceWith(text)
      continue
    }

    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      const isData = name.startsWith('data-')
      if (name.startsWith('on') || (!isData && !ALLOW_ATTRS.has(name))) {
        child.removeAttribute(attr.name)
        continue
      }
      if ((name === 'href' || name === 'src') && !sanitizeUrl(attr.value)) {
        child.removeAttribute(attr.name)
      }
    }

    if (tag === 'a') {
      child.setAttribute('target', '_blank')
      child.setAttribute('rel', 'noopener noreferrer nofollow')
    }
    if (tag === 'img') {
      child.setAttribute('loading', 'lazy')
      child.setAttribute('referrerpolicy', 'no-referrer')
    }

    cleanNode(child)
  }
}

/**
 * 返回可安全渲染的 HTML 字符串。
 *
 * 用 `DOMParser` 在游离文档里解析，解析过程中不会执行脚本、不会发起请求。
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  cleanNode(doc.body)
  return doc.body.innerHTML
}

/** 从 HTML 中抽出图片地址，用于详情页的图片预览。 */
export function collectImages(html: string | null | undefined): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const urls = Array.from(doc.querySelectorAll('img'))
    .map((img) => img.getAttribute('src') ?? '')
    .filter((src) => sanitizeUrl(src) !== null)
  return Array.from(new Set(urls))
}
