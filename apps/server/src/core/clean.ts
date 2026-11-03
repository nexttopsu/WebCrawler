/**
 * 文本与 HTML 清洗。
 *
 * 清洗结果会进入数据库与前端展示，因此这里同时承担「去噪」与「去危险内容」两件事：
 * 移除脚本、事件属性、javascript: 协议等，避免脏 HTML 被直接渲染。
 */
import { load, type CheerioAPI } from 'cheerio'
import type { FieldCleanRule } from '../shared/index.js'

/** 正文 HTML 中一律移除的标签。 */
const DANGEROUS_TAGS = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta']

/** 允许保留的 URL 协议。 */
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:|\/|#|\.)/i

/** 清洗文本：去空白、去零宽字符、按规则替换。 */
export function cleanText(input: string | null | undefined, rule: FieldCleanRule = {}): string {
  if (input === null || input === undefined) return ''

  let text = input
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .replace(/\r\n?/g, '\n')

  if (rule.replace) {
    try {
      text = text.replace(new RegExp(rule.replace.pattern, 'g'), rule.replace.with)
    } catch {
      // 非法正则不应让整篇文章失败，保留原文本
    }
  }

  if (rule.removePattern) {
    try {
      text = text.replace(new RegExp(rule.removePattern, 'g'), '')
    } catch {
      // 同上
    }
  }

  if (rule.collapseWhitespace) {
    // 折叠行内空白，同时去掉行首行尾空格，但保留段落换行
    text = text.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n')
  }

  if (rule.trim !== false) {
    text = text.trim()
  }

  return text
}

export interface CleanHtmlOptions {
  /** 额外移除的选择器（广告、推荐位等） */
  removeSelectors?: string[]
}

/** 检查 URL 是否安全（拒绝 javascript: / data: 等）。 */
function isSafeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/^data:image\//i.test(trimmed)) return true
  if (/^(javascript|vbscript|file):/i.test(trimmed)) return false
  if (SAFE_URL_SCHEME.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true
  // 站内相对地址：`upload/2026/a.jpg`、`news/1.html`。
  // 没有 scheme 就没有脚本执行能力，不能当成危险链接删掉，
  // 否则站内图片会在 cleanHtml 这一步就丢失（absolutize 之后才有绝对地址）。
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
}

/** 清洗正文 HTML：移除危险标签、事件属性、危险 URL，返回干净的 HTML。 */
export function cleanHtml(input: string | null | undefined, options: CleanHtmlOptions = {}): string {
  if (!input) return ''

  const $ = load(input, undefined, false)

  $(DANGEROUS_TAGS.join(',')).remove()
  for (const selector of options.removeSelectors ?? []) {
    if (!selector.trim()) continue
    try {
      $(selector).remove()
    } catch {
      // 选择器非法时跳过，不影响其它清洗步骤
    }
  }

  $('*').each((_index, element) => {
    const attribs = $(element).attr() ?? {}
    for (const [name, value] of Object.entries(attribs)) {
      const lower = name.toLowerCase()
      if (lower.startsWith('on')) {
        $(element).removeAttr(name)
        continue
      }
      if ((lower === 'href' || lower === 'src' || lower === 'srcset' || lower === 'action') && !isSafeUrl(value)) {
        $(element).removeAttr(name)
      }
    }
  })

  return $.html()
}

/** 从 HTML 中提取图片地址并转为绝对地址，按出现顺序去重。 */
export function extractImages(
  input: string | null | undefined,
  resolve: (value: string) => string,
  options: { selectors?: string[] } = {},
): string[] {
  if (!input) return []
  const $ = load(input, undefined, false)
  const selectors = options.selectors?.length ? options.selectors : ['img']
  const images: string[] = []
  const seen = new Set<string>()

  for (const selector of selectors) {
    $(selector).each((_index, element) => {
      const candidates = [
        $(element).attr('src'),
        $(element).attr('data-src'),
        $(element).attr('data-original'),
        $(element).attr('data-lazy-src'),
      ]
      for (const candidate of candidates) {
        if (!candidate) continue
        const absolute = resolve(candidate.trim())
        if (!absolute || !/^https?:/i.test(absolute)) continue
        if (seen.has(absolute)) continue
        seen.add(absolute)
        images.push(absolute)
      }
    })
  }

  return images
}

/**
 * 把正文中的相对地址转成绝对地址。
 *
 * 入库的 HTML 会在管理后台直接展示，若保留相对地址，图片与链接会指向后台域名而失效。
 * 只处理自身可解析的相对地址，跳过 `#anchor`、`mailto:`、`tel:` 等。
 */
export function absolutizeHtml(input: string, resolve: (value: string) => string): string {
  if (!input) return ''
  const $ = load(input, undefined, false)

  const rewrite = (selector: string, attribute: string): void => {
    $(selector).each((_index, element) => {
      const value = $(element).attr(attribute)
      if (!value || value.startsWith('#') || /^(mailto|tel|data):/i.test(value)) return
      const absolute = resolve(value)
      if (absolute) $(element).attr(attribute, absolute)
    })
  }

  rewrite('img[src]', 'src')
  rewrite('a[href]', 'href')
  return $.html()
}

/** 统计 HTML 中的纯文本长度，用于正文质量校验。 */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return ''
  const $: CheerioAPI = load(input, undefined, false)
  $('script, style, noscript').remove()
  return cleanText($.root().text(), { collapseWhitespace: true })
}
