/**
 * request-pack 提供的 URL 工具封装。
 *
 * 采集核心不直接依赖 request-pack，需要相对地址解析时从这里取，
 * 保证第三方实现只在请求层出现一次，便于将来替换。
 */
import { utils } from 'request-pack'

/** 把相对地址解析为绝对地址。 */
export function resolveUrl(href: string, base?: string): string {
  return utils.resolveUrl(href, base)
}

/** 取文档中的 `<base href>`。 */
export function getBaseHref(html: string): string | undefined {
  return utils.getBaseHref(html)
}

/** 计算文档基准地址：优先 `<base href>`，否则用页面地址。 */
export function getDocumentBase(html: string, pageUrl: string): string {
  return utils.getDocumentBase(html, pageUrl)
}
