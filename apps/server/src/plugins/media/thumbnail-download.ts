/**
 * 通用解析器插件 · 列表缩略图下载
 *
 * 作用于列表阶段（parseList）：检查条目的 `coverUrl` 字段，
 * 有值且图片路径合法（能补全为 http(s) 地址、响应确实是图片）时，
 * 把图片下载到仓库根 `resources/covers/<站点标识>/` 目录，
 * 并把 `coverUrl` 替换为可直接访问的 URL 路径
 * （`/resources/covers/<站点标识>/<哈希>.<扩展名>`，由服务端静态托管）。
 *
 * 失败兜底（任一步失败都不影响采集）：
 * - 无值 / 已是托管资源路径 / 无法补全为合法 http(s) 地址 → 原样返回，不改字段；
 * - 下载失败、非图片内容、写盘失败 → `logger.warn` 记录原因，原样返回，绝不抛错。
 *
 * 其它说明：
 * - 文件名取**完整图片链接**（补全后的下载地址）的 MD5（32 位十六进制），
 *   确定性命名；下载前先按哈希前缀在本地目录查找已有文件，命中即跳过下载，
 *   避免重复下载；
 * - 下载走 `ctx.request`（平台统一的代理 / SSRF / 超时路径），不要绕开；
 * - `/resources/**` 由后端托管（见 `src/server/lib/resources.ts`），
 *   dev 环境下 Vite 会把该前缀代理到后端，前端可直接展示。
 */
import md5 from 'md5'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { definePlugin } from '../../plugin-system/sdk.js'
import type { ArticleFields, PluginContext } from '../../plugin-system/types.js'

/** 静态资源 URL 前缀：与服务端 `src/server/lib/resources.ts` 保持一致。 */
const RESOURCES_URL_PREFIX = '/resources'

/**
 * 静态资源根目录：仓库根 `resources/`。
 * 仓库根从进程工作目录向上找 `pnpm-workspace.yaml` 确定；找不到退回工作目录。
 */
const WORKSPACE_ROOT = findWorkspaceRoot(process.cwd())
const SAVE_ROOT = resolve(WORKSPACE_ROOT, 'resources', 'covers')

/** 单张图片大小上限（字节）。 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** Content-Type → 扩展名（优先于 URL 后缀，更可靠）。 */
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
}

/** URL 后缀白名单：不在其中的地址下载后必须有可识别的图片魔数才接受。 */
const URL_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico)$/i

/** 从起始目录向上查找仓库根（含 pnpm-workspace.yaml 的目录）；找不到退回起始目录。 */
function findWorkspaceRoot(startDir: string): string {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return resolve(startDir)
    dir = parent
  }
}

/** 通过魔数识别图片类型；识别不出返回 null。 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/avif'
  // SVG 是文本，做个宽松识别
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<?xml') && head.includes('<svg')) return 'image/svg+xml'
  if (head.startsWith('<svg')) return 'image/svg+xml'
  return null
}

/** Content-Type → 扩展名；识别不出返回 null。 */
function extFromContentType(contentType: string): string | null {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return CONTENT_TYPE_EXT[mime] ?? null
}

/** URL 路径后缀 → 扩展名（带点）；不合法返回 null。 */
function extFromUrl(url: string): string | null {
  const match = URL_EXT_RE.exec(url.split('?')[0]?.split('#')[0] ?? '')
  return match ? `.${match[1]!.toLowerCase().replace('jpeg', 'jpg')}` : null
}

/** 目录名清洗：只保留安全字符。 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'default'
}

/** 判断是否为 http(s) 地址。 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 判断是否为平台托管的资源路径（URL 或本地路径），无需再处理。 */
function isManagedResourcePath(value: string): boolean {
  if (isAbsolute(value)) return true
  return /^\/?resources[\\/]/i.test(value)
}

/**
 * 把原始 coverUrl 归一化为可下载的 http(s) 地址。
 *
 * - 已是托管资源路径（`/resources/...` 等）→ null，直接跳过；
 * - 协议相对（`//host/a.jpg`）→ 补 https；
 * - 页面相对路径 → 先按文章地址补全，再按站点 baseUrl 兜底；
 * - 非 http(s) 协议（data: / blob: 等）→ null。
 */
function resolveCoverUrl(raw: string, pageUrl: string, ctx: PluginContext): string | null {
  const value = raw.trim()
  if (!value) return null

  if (isManagedResourcePath(value)) return null

  let candidate = value
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    // 页面相对路径：依次按文章地址、站点 baseUrl 补全
    const byPage = ctx.parser.resolveUrl(candidate, pageUrl)
    if (byPage && isHttpUrl(byPage)) return byPage
    const baseUrl = ctx.site?.baseUrl
    if (baseUrl) {
      const bySite = ctx.parser.resolveUrl(candidate, baseUrl)
      if (bySite && isHttpUrl(bySite)) return bySite
    }
    return null
  }

  return isHttpUrl(candidate) ? candidate : null
}

/** 拼接资源访问 URL：/resources/covers/<站点>/<文件名>。 */
function resourceUrl(dirName: string, fileName: string): string {
  return `${RESOURCES_URL_PREFIX}/covers/${dirName}/${fileName}`
}

/** 对单条 coverUrl 执行「查本地 → 下载 → 校验内容 → 落盘」，返回可访问的 URL 路径；失败抛错。 */
async function downloadCover(
  target: string,
  ctx: PluginContext,
): Promise<{ urlPath: string; reused: boolean }> {
  // 确定性文件名：完整图片链接的 MD5（32 位十六进制）
  const hash = md5(target)
  const dirName = sanitizeSegment(ctx.siteId ?? ctx.site?.domain ?? 'default')
  const dir = resolve(SAVE_ROOT, dirName)

  // 下载前先查本地：扩展名下载前未知，按「哈希.」前缀匹配任意扩展名
  if (existsSync(dir)) {
    const existing = readdirSync(dir).find((name) => name.startsWith(`${hash}.`))
    if (existing) return { urlPath: resourceUrl(dirName, existing), reused: true }
  }

  const response = await ctx.request.get(target, {
    maxBytes: IMAGE_MAX_BYTES,
    retries: 1,
    throwOnHttpError: true,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const body = response.body
  if (body.length === 0) throw new Error('响应体为空')

  // 双重校验：Content-Type 或魔数至少一个认定是图片（防 HTML 错误页冒充）
  const mime = sniffImageMime(body)
  const contentType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const isImage = mime !== null || contentType.startsWith('image/')
  if (!isImage) throw new Error(`内容不是图片（Content-Type: ${contentType || '未知'}）`)

  const ext = extFromContentType(response.contentType) ?? extFromUrl(response.finalUrl) ?? '.jpg'
  const fileName = `${hash}${ext}`
  await mkdir(dir, { recursive: true })
  await writeFile(resolve(dir, fileName), body)

  // 生成可直接访问的 URL 路径（服务端静态托管 /resources/**）
  return { urlPath: resourceUrl(dirName, fileName), reused: false }
}

export default definePlugin({
  config: {
    id: 'generic-cover-download',
    name: '通用 · 缩略图下载',
    type: 'parser',
    version: '1.2.0',
    description:
      '列表阶段检查 coverUrl，合法则下载图片到 resources/covers/ 并替换为 /resources/ 访问路径；无值或失败时保持原样',
  },

  async parseList(url, fields: ArticleFields, ctx) {
    const raw = fields.coverUrl
    if (typeof raw !== 'string' || !raw.trim()) return fields

    const target = resolveCoverUrl(raw, url, ctx)
    if (!target) return fields

    try {
      const { urlPath, reused } = await downloadCover(target, ctx)
      ctx.logger.info(reused ? `缩略图已存在，跳过下载：${urlPath}（来源 ${target}）` : `缩略图已保存：${urlPath}（来源 ${target}）`)
      return { ...fields, coverUrl: urlPath }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`缩略图下载失败，保持原 coverUrl（${target}）：${reason}`)
      return fields
    }
  },
})
