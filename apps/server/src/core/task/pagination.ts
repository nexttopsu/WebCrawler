/**
 * 分页地址生成。
 *
 * 只实现能稳定测试的 `none` / `query` / `path`：
 * - `next` / `cursor` 需要读取上一页内容或维护游标状态，
 *   语义尚未定义完整，这里明确抛错，绝不静默当作单页抓取。
 *
 * 生成结果必须与列表页同源：`path` 模板里的相对路径按列表页解析，
 * 若解析后主机发生变化则拒绝，避免规则把抓取带到别的域名。
 */
import type { PaginationConfig } from '../../shared/index.js'

/** 分页不受支持或配置不完整。 */
export class PaginationError extends Error {
  override readonly name = 'PaginationError'
  readonly code = 'PAGINATION_UNSUPPORTED'

  constructor(message: string) {
    super(message)
  }
}

/** 判断一个分页配置是否可执行。 */
export function isExecutablePagination(pagination: PaginationConfig | undefined): boolean {
  if (!pagination) return true
  return pagination.type === 'none' || pagination.type === 'query' || pagination.type === 'path'
}

/**
 * 生成第 N 页地址（N 从 1 开始）。
 *
 * 返回 `null` 表示「没有下一页」（`none` 或超出页数上限由调用方判断）。
 * 配置非法时抛 `PaginationError`。
 */
export function buildPageUrl(
  listUrl: string,
  pagination: PaginationConfig | undefined,
  page: number,
): string | null {
  if (page < 1 || !Number.isInteger(page)) {
    throw new PaginationError(`页码必须是正整数，收到 ${page}`)
  }
  if (!pagination || pagination.type === 'none') {
    return page === 1 ? listUrl : null
  }

  if (pagination.type === 'next' || pagination.type === 'cursor') {
    throw new PaginationError(
      `分页类型 ${pagination.type} 尚未实现，请改为 query 或 path`,
    )
  }

  if (pagination.type === 'query') {
    const parameter = pagination.parameter?.trim() || 'page'
    const start = Number.isFinite(pagination.start) ? Number(pagination.start) : 1
    const value = start + (page - 1)
    const url = new URL(listUrl)
    url.searchParams.set(parameter, String(value))
    return url.toString()
  }

  // path
  const pattern = pagination.pathPattern?.trim()
  if (!pattern) {
    throw new PaginationError('分页类型 path 必须提供 pathPattern（例如 /news/page/{page}）')
  }
  if (!pattern.includes('{page}')) {
    throw new PaginationError('pathPattern 必须包含 {page} 占位符')
  }
  if (page === 1) return listUrl

  const base = new URL(listUrl)
  const target = new URL(pattern.replace(/\{page\}/g, String(page)), base)
  if (target.origin !== base.origin) {
    throw new PaginationError(
      `pathPattern 生成的分页地址与列表页不同源：${target.origin} ≠ ${base.origin}`,
    )
  }
  return target.toString()
}

/**
 * 生成从第 1 页开始的分页地址序列（最多 `maxPages` 页）。
 *
 * 遇到 `null` 立即停止；不支持的类型会抛出 `PaginationError`，
 * 由任务执行器转成一条明确的失败原因。
 */
export function buildPageUrls(
  listUrl: string,
  pagination: PaginationConfig | undefined,
  maxPages: number,
): string[] {
  return buildPageUrlRange(listUrl, pagination, 1, maxPages)
}

/**
 * 生成 `[startPage, endPage]` 闭区间的分页地址序列（页码从 1 开始）。
 *
 * - 区间最多 500 页，超出会被截断；
 * - `none` 分页只有第 1 页，区间不含第 1 页时返回空数组；
 * - 遇到 `null`（没有该页）立即停止；不支持的类型抛 `PaginationError`。
 */
export function buildPageUrlRange(
  listUrl: string,
  pagination: PaginationConfig | undefined,
  startPage: number,
  endPage: number,
): string[] {
  const from = Math.max(1, Math.floor(startPage))
  const to = Math.min(Math.max(Math.floor(endPage), from), from + 499)
  const urls: string[] = []
  for (let page = from; page <= to; page += 1) {
    const url = buildPageUrl(listUrl, pagination, page)
    if (!url) break
    urls.push(url)
  }
  return urls
}
