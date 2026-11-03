import { getDatabaseContext, getModels, type ProxyRow } from '../../database/index.js'
import { PROXY_TYPES, type ProxyDto, type ProxyTestResultDto, type ProxyType } from '../../shared/index.js'
import { RequestError, type RequestClient } from '../../request/index.js'
import { z } from 'zod'
import { ConfigurationError, ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { encryptProxyPassword, hasProxySecret } from '../lib/proxy-secret.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import { isValidDomain, proxyToSettings, textOrNull } from './common.js'

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

const hostField = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(isValidDomain, '主机格式不合法：只接受 example.com 或 IPv4 地址')

const nameField = z.string().trim().min(1).max(100)
const usernameField = z.string().trim().max(128).nullable().optional()
const passwordField = z.string().max(256).nullable().optional()

export const proxyCreateSchema = z
  .object({
    name: nameField,
    type: z.enum(PROXY_TYPES),
    host: hostField,
    port: z.number().int().min(1).max(65_535),
    username: usernameField,
    password: passwordField,
    enabled: z.boolean().optional(),
  })
  .strict()

export const proxyUpdateSchema = proxyCreateSchema.partial().strict()

export const proxyListQuerySchema = z.object({
  ...paginationFields,
  keyword: keywordField,
  type: z.enum(PROXY_TYPES).optional(),
  status: z.enum(['unknown', 'available', 'unavailable', 'disabled']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
})

export const proxyEnabledSchema = z.object({ enabled: z.boolean() }).strict()

export const proxyTestSchema = z.object({ url: z.string().trim().url().max(2048).optional() }).strict()

export type ProxyCreateInput = z.infer<typeof proxyCreateSchema>
export type ProxyUpdateInput = z.infer<typeof proxyUpdateSchema>
export type ProxyListQuery = z.infer<typeof proxyListQuerySchema>

/* -------------------------------------------------------------------------- */
/* 映射                                                                        */
/* -------------------------------------------------------------------------- */

export function toProxyDto(row: ProxyRow): ProxyDto {
  return {
    id: row.id,
    name: row.name?.trim() || `${row.protocol ?? 'http'}://${row.host ?? ''}:${row.port ?? 0}`,
    type: (row.protocol === 'https' || row.protocol === 'socks5' ? row.protocol : 'http') as ProxyType,
    host: row.host ?? '',
    port: row.port ?? 0,
    username: row.username,
    // 只暴露「是否有密码」，不返回明文、密文或长度
    hasPassword: Boolean(row.password),
    enabled: row.enabled !== 0 && row.status !== 'disabled',
    status: (row.status ?? 'unknown') as ProxyDto['status'],
    lastTestAt: row.lastCheckedAt,
    lastTestStatus: row.lastTestStatus,
    requestCount: row.requestCount ?? 0,
    successCount: row.successCount ?? 0,
    failedCount: row.failCount ?? 0,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

export function findProxy(id: number): ProxyRow {
  const row = getModels().proxy.findById(id)
  if (!row) throw new NotFoundError(`代理 ${id} 不存在`)
  return row
}

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

function assertEndpointUnique(type: string, host: string, port: number, excludeId?: number): void {
  const existing = getModels().proxy.findOne({ protocol: type, host, port })
  if (existing && existing.id !== excludeId) {
    throw new ConflictError(`代理 ${type}://${host}:${port} 已存在`, {
      protocol: type,
      host,
      port,
      proxyId: existing.id,
    })
  }
}

/** 密码字段的处理：undefined 表示不改，null / 空串表示清空。 */
function resolvePassword(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined
  const value = textOrNull(input ?? null)
  if (!value) return null
  if (!hasProxySecret()) {
    throw new ConfigurationError(
      '未配置 PROXY_SECRET_KEY，无法安全保存代理密码。请在环境变量中设置至少 16 个字符的密钥后重启服务。',
    )
  }
  return encryptProxyPassword(value)
}

export function listProxies(query: ProxyListQuery) {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.keyword) {
    conditions.push("(t.name LIKE ? ESCAPE '\\' OR t.host LIKE ? ESCAPE '\\')")
    const pattern = likePattern(query.keyword)
    params.push(pattern, pattern)
  }
  if (query.type) {
    conditions.push('t.protocol = ?')
    params.push(query.type)
  }
  if (query.status) {
    conditions.push('t.status = ?')
    params.push(query.status)
  }
  if (query.enabled) {
    conditions.push('t.enabled = ?')
    params.push(query.enabled === 'true' ? 1 : 0)
  }

  const { rows, total } = runRawList<ProxyRow>(getDatabaseContext().db, {
    select:
      't.id, t.name, t.host, t.port, t.protocol, t.username, t.password, t.enabled, t.status, t.failCount, t.successCount, t.requestCount, t.lastCheckedAt, t.lastTestStatus, t.lastUsedAt, t.expiresAt, t.createdAt, t.updatedAt',
    from: 'proxy t',
    conditions,
    params,
    orderBy: 't.id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toProxyDto), total, query.page, query.pageSize)
}

export function getProxy(id: number): ProxyDto {
  return toProxyDto(findProxy(id))
}

export function createProxy(input: ProxyCreateInput): ProxyDto {
  assertEndpointUnique(input.type, input.host, input.port)
  const password = resolvePassword(input.password)
  const enabled = input.enabled ?? true

  const created = getModels().proxy.create({
    name: input.name,
    host: input.host,
    port: input.port,
    protocol: input.type,
    username: textOrNull(input.username ?? null),
    password: password ?? null,
    enabled: enabled ? 1 : 0,
    status: enabled ? 'unknown' : 'disabled',
    failCount: 0,
    successCount: 0,
    requestCount: 0,
    lastCheckedAt: null,
    lastTestStatus: null,
    lastUsedAt: null,
    expiresAt: null,
  })
  return toProxyDto(created)
}

export function updateProxy(id: number, input: ProxyUpdateInput): ProxyDto {
  const row = findProxy(id)
  const type = input.type ?? row.protocol ?? 'http'
  const host = input.host ?? row.host ?? ''
  const port = input.port ?? row.port ?? 0
  assertEndpointUnique(type, host, port, id)

  const password = resolvePassword(input.password)
  const enabled = input.enabled ?? row.enabled !== 0
  const status = enabled ? (row.status === 'disabled' ? 'unknown' : row.status ?? 'unknown') : 'disabled'

  const updated = getModels().proxy.update(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.type !== undefined ? { protocol: input.type } : {}),
    ...(input.host !== undefined ? { host } : {}),
    ...(input.port !== undefined ? { port } : {}),
    ...(input.username !== undefined ? { username: textOrNull(input.username ?? null) } : {}),
    ...(password !== undefined ? { password } : {}),
    enabled: enabled ? 1 : 0,
    status,
  })

  if (!updated) throw new NotFoundError(`代理 ${id} 不存在`)
  return toProxyDto(updated)
}

export function setProxyEnabled(id: number, enabled: boolean): ProxyDto {
  findProxy(id)
  const updated = getModels().proxy.update(id, {
    enabled: enabled ? 1 : 0,
    status: enabled ? 'unknown' : 'disabled',
    lastTestStatus: enabled ? null : 'disabled',
  })
  if (!updated) throw new NotFoundError(`代理 ${id} 不存在`)
  return toProxyDto(updated)
}

/** 删除代理：被站点/栏目引用时默认拒绝，`force` 只解除引用，不删业务数据。 */
export function deleteProxy(id: number, options: { force?: boolean } = {}): { deleted: boolean } {
  const row = findProxy(id)
  const models = getModels()
  const sites = models.site.findMany({ defaultProxyId: id })
  const categories = models.category.findMany({ proxyId: id })

  if (sites.length > 0 || categories.length > 0) {
    if (!options.force) {
      throw new ConflictError(`代理 ${id} 仍被 ${sites.length} 个站点与 ${categories.length} 个栏目引用`, {
        sites: sites.map((item) => ({ id: item.id, name: item.name })),
        categories: categories.map((item) => ({ id: item.id, name: item.name })),
        hint: '确认不再使用后可带 ?force=true 解除引用再删除',
      })
    }
    for (const site of sites) models.site.update(site.id, { defaultProxyId: null })
    for (const category of categories) models.category.update(category.id, { proxyId: null })
  }

  models.proxy.delete(row.id)
  return { deleted: true }
}

/* -------------------------------------------------------------------------- */
/* 连通性测试                                                                  */
/* -------------------------------------------------------------------------- */

const TEST_TIMEOUT_MS = 10_000
const TEST_MAX_BYTES = 256 * 1024

/**
 * 通过代理请求一个地址，验证代理是否真的可用。
 *
 * 失败不抛 500：返回 `ok:false` 并写回状态，让管理界面能看到原因。
 * 错误信息里不包含用户名密码（请求层的错误本身也不含）。
 */
export async function testProxy(
  id: number,
  request: RequestClient,
  targetUrl: string,
): Promise<ProxyTestResultDto> {
  const row = findProxy(id)
  const startedAt = performance.now()
  const testedAt = new Date().toISOString()

  if (row.enabled === 0 || row.status === 'disabled') {
    throw new ConflictError(`代理 ${id} 已禁用，不能测试`, { proxyId: id })
  }

  let ok = false
  let statusCode: number | null = null
  let message = ''
  let status: 'available' | 'unavailable' = 'unavailable'

  try {
    const response = await request.get(targetUrl, {
      proxy: proxyToSettings(row),
      timeoutMs: TEST_TIMEOUT_MS,
      maxBytes: TEST_MAX_BYTES,
      retries: 0,
      headers: { 'user-agent': 'WebCrawler proxy-check/1.0' },
    })
    statusCode = response.status
    ok = response.ok
    status = response.ok ? 'available' : 'unavailable'
    message = response.ok ? `代理可用（HTTP ${response.status}）` : `代理返回 HTTP ${response.status}`
  } catch (error) {
    message =
      error instanceof RequestError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
  }

  getModels().proxy.update(id, {
    status,
    lastTestStatus: status,
    lastCheckedAt: testedAt,
    ...(ok ? { successCount: (row.successCount ?? 0) + 1 } : { failCount: (row.failCount ?? 0) + 1 }),
  })

  return {
    ok,
    url: targetUrl,
    statusCode,
    elapsedMs: Math.round(performance.now() - startedAt),
    message,
    testedAt,
  }
}

/** 校验测试目标地址只能是 http/https。 */
export function assertHttpUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ValidationError('测试地址不是合法的 URL', [
      { path: 'url', message: '不是合法的 URL', code: 'invalid_format' },
    ])
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('测试地址只支持 http / https', [
      { path: 'url', message: '只支持 http / https', code: 'invalid_value' },
    ])
  }
  return url.toString()
}
