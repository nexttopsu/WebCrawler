import { getModels, type SiteRow } from '@webcrawler/database'
import { createParser } from '@webcrawler/core'
import { RequestError, type RequestClient } from '@webcrawler/request'
import type {
  PaginatedData,
  SiteConnectionTestDto,
  SiteDetailDto,
  SiteDto,
  SiteStatus,
} from '@webcrawler/shared'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import {
  assertProxyUsable,
  findRuleOrThrow,
  findSiteOrThrow,
  isValidDomain,
  normalizeDomain,
  resolveBaseUrl,
  textOrNull,
  toRuleSummary,
  toSiteDto,
} from './common.js'

const SITE_COLUMNS =
  'id, name, domain, baseUrl, pluginName, defaultProxyId, defaultRuleId, status, description, createdAt, updatedAt'

const domainField = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(isValidDomain, '域名格式不合法：只接受 example.com 这类主机名或 IPv4 地址')

const nameField = z.string().trim().min(1).max(100)
const descriptionField = z.string().trim().max(500).nullable().optional()
const pluginNameField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '插件名只能包含字母、数字、点、下划线与短横线')
  .nullable()
  .optional()
const idField = z.number().int().positive()

/** 创建站点的输入。`defaultRuleId` 不在创建时提供——规则必须先有所属站点。 */
export const siteCreateSchema = z
  .object({
    name: nameField,
    domain: domainField,
    baseUrl: z.string().trim().max(2048).optional(),
    pluginName: pluginNameField,
    defaultProxyId: idField.nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    description: descriptionField,
  })
  .strict()

/** PUT 的输入：必填字段与创建一致，可选字段缺省时重置为空。 */
export const siteReplaceSchema = siteCreateSchema.extend({
  defaultRuleId: idField.nullable().optional(),
})

/** PATCH 的输入：任意子集。 */
export const sitePatchSchema = siteReplaceSchema.partial()

/** 列表查询参数。 */
export const siteListQuerySchema = z.object({
  ...paginationFields,
  keyword: keywordField,
  status: z.enum(['active', 'inactive']).optional(),
  pluginName: z.string().trim().max(64).optional(),
})

export const siteStatusSchema = z.object({ status: z.enum(['active', 'inactive']) }).strict()

export type SiteCreateInput = z.infer<typeof siteCreateSchema>
export type SitePatchInput = z.infer<typeof sitePatchSchema>
export type SiteListQuery = z.infer<typeof siteListQuerySchema>

/** 网站列表：支持关键词（名称 / 域名 / 基址）、状态与插件筛选。 */
export function listSites(query: SiteListQuery): PaginatedData<SiteDto> {
  const conditions: string[] = []
  const params: Array<string | number | null> = []

  if (query.status) {
    conditions.push('status = ?')
    params.push(query.status)
  }
  if (query.pluginName) {
    conditions.push('pluginName = ?')
    params.push(query.pluginName)
  }
  if (query.keyword) {
    const pattern = likePattern(query.keyword)
    conditions.push(`(name LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\' OR baseUrl LIKE ? ESCAPE '\\')`)
    params.push(pattern, pattern, pattern)
  }

  const { rows, total } = runRawList<SiteRow>(getModels().site.db, {
    select: SITE_COLUMNS,
    from: 'site',
    conditions,
    params,
    orderBy: 'id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toSiteDto), total, query.page, query.pageSize)
}

/** 网站详情：附带关联计数，便于前端在删除前给出提示。 */
export function getSite(id: number): SiteDetailDto {
  const site = findSiteOrThrow(id)
  const models = getModels()
  const defaultRule = site.defaultRuleId ? models.crawlRule.findById(site.defaultRuleId) : undefined

  return {
    ...toSiteDto(site),
    defaultRule: defaultRule ? toRuleSummary(defaultRule) : null,
    counts: {
      categories: models.category.count({ siteId: id }),
      rules: models.crawlRule.count({ siteId: id }),
      tasks: models.crawlTask.count({ siteId: id }),
      articles: models.article.count({ siteId: id }),
    },
  }
}

function assertDomainAvailable(domain: string, excludeId?: number): void {
  const existing = getModels().site.findOne({ domain })
  if (existing && existing.id !== excludeId) {
    throw new ConflictError(`域名 ${domain} 已被站点「${existing.name ?? existing.id}」使用`, {
      domain,
      siteId: existing.id,
    })
  }
}

/** 校验默认规则：必须存在、属于本站点、且是站点级规则（categoryId 为空）。 */
function assertDefaultRule(ruleId: number, siteId: number): number {
  const rule = findRuleOrThrow(ruleId)
  if (rule.siteId !== siteId) {
    throw new ValidationError('默认规则必须属于当前站点', [
      { path: 'defaultRuleId', message: '规则不属于该站点', code: 'invalid_value' },
    ])
  }
  if (rule.categoryId !== null) {
    throw new ValidationError('默认规则不能是栏目规则', [
      { path: 'defaultRuleId', message: '请选择站点级规则（categoryId 为空）', code: 'invalid_value' },
    ])
  }
  return ruleId
}

/** 创建网站。 */
export function createSite(input: SiteCreateInput): SiteDto {
  const domain = normalizeDomain(input.domain)
  const baseUrl = resolveBaseUrl(input.baseUrl, domain)

  assertDomainAvailable(domain)
  if (input.defaultProxyId) assertProxyUsable(input.defaultProxyId)

  const created = getModels().site.create({
    name: input.name,
    domain,
    baseUrl,
    pluginName: textOrNull(input.pluginName),
    defaultProxyId: input.defaultProxyId ?? null,
    status: input.status ?? 'active',
    description: textOrNull(input.description),
  })

  return toSiteDto(created)
}

/**
 * 更新网站。
 *
 * `replace=true`（PUT）时未提供的可选字段会重置为空；
 * `replace=false`（PATCH）时只更新出现的字段。
 */
export function updateSite(id: number, input: SitePatchInput, replace = false): SiteDto {
  const current = findSiteOrThrow(id)
  const models = getModels()

  const domain =
    input.domain !== undefined ? normalizeDomain(input.domain) : normalizeDomain(current.domain ?? '')
  if (!domain) throw new ValidationError('domain 不能为空')

  if (input.domain !== undefined) assertDomainAvailable(domain, id)

  // 域名变了但没给 baseUrl：按新域名重新生成，避免主机名与域名不一致
  const baseUrl =
    input.baseUrl !== undefined
      ? resolveBaseUrl(input.baseUrl, domain)
      : input.domain !== undefined
        ? resolveBaseUrl(undefined, domain)
        : (current.baseUrl ?? resolveBaseUrl(undefined, domain))

  if (input.defaultProxyId) assertProxyUsable(input.defaultProxyId)

  const defaultRuleId =
    input.defaultRuleId === undefined
      ? replace
        ? null
        : current.defaultRuleId
      : input.defaultRuleId === null
        ? null
        : assertDefaultRule(input.defaultRuleId, id)

  const pluginName =
    input.pluginName === undefined
      ? replace
        ? null
        : current.pluginName
      : textOrNull(input.pluginName)

  const updated = models.site.update(id, {
    name: input.name ?? current.name,
    domain,
    baseUrl,
    pluginName,
    defaultProxyId:
      input.defaultProxyId === undefined
        ? replace
          ? null
          : current.defaultProxyId
        : (input.defaultProxyId ?? null),
    defaultRuleId,
    status: input.status ?? (replace ? 'active' : (current.status ?? 'active')),
    description: replace
      ? textOrNull(input.description)
      : input.description === undefined
        ? current.description
        : textOrNull(input.description),
  })

  if (!updated) throw new NotFoundError(`站点 ${id} 不存在`)
  return toSiteDto(updated)
}

/** 启用 / 禁用网站。 */
export function setSiteStatus(id: number, status: SiteStatus): SiteDto {
  const updated = getModels().site.update(id, { status })
  if (!updated) throw new NotFoundError(`站点 ${id} 不存在`)
  return toSiteDto(updated)
}

export interface DeleteSiteOptions {
  /** 允许在存在栏目 / 规则时一并删除它们；文章或任务存在时永远拒绝 */
  force?: boolean
}

/**
 * 删除网站。
 *
 * 删除策略（默认限制删除，不做无提示级联）：
 * - 存在文章或采集任务 → 一律拒绝，交由数据管理阶段处理；
 * - 存在栏目或规则 → 默认拒绝；`force=true` 时连同栏目、规则与规则版本一起删除；
 * - 只删除配置，不触碰文章与任务。
 */
export function deleteSite(id: number, options: DeleteSiteOptions = {}): { id: number; detached: number } {
  const site = findSiteOrThrow(id)
  const models = getModels()

  const counts = {
    categories: models.category.count({ siteId: id }),
    rules: models.crawlRule.count({ siteId: id }),
    tasks: models.crawlTask.count({ siteId: id }),
    articles: models.article.count({ siteId: id }),
  }

  if (counts.articles > 0 || counts.tasks > 0) {
    throw new ConflictError('站点下存在文章或采集任务，无法删除；请先迁移数据或改为禁用', {
      siteId: id,
      counts,
    })
  }

  if ((counts.categories > 0 || counts.rules > 0) && !options.force) {
    throw new ConflictError('站点下仍有栏目或规则，请先删除它们，或使用 force=true 一并删除配置', {
      siteId: id,
      counts,
    })
  }

  const ruleIds = models.crawlRule.findMany({ siteId: id }).map((row) => row.id)

  models.site.db.transaction(() => {
    if (ruleIds.length > 0) {
      models.crawlRuleVersion.deleteMany({ ruleId: { in: ruleIds } })
      models.crawlRule.deleteMany({ siteId: id })
    }
    if (counts.categories > 0) models.category.deleteMany({ siteId: id })
    models.site.delete(site.id)
  })

  return { id, detached: counts.categories + counts.rules }
}

/**
 * 测试网站连接。
 *
 * 只做一次 GET：确认域名可解析、TLS 正常、HTTP 可达，并尝试读取页面标题。
 * 失败不抛异常，把原因放进结果，便于管理界面直接展示。
 */
export async function testSiteConnection(
  id: number,
  deps: { request: RequestClient },
): Promise<SiteConnectionTestDto> {
  const site = findSiteOrThrow(id)
  const url = site.baseUrl ?? resolveBaseUrl(undefined, site.domain ?? '')
  const startedAt = performance.now()

  try {
    const response = await deps.request.get(url, { timeoutMs: 15_000, retries: 0, maxRedirects: 3 })
    let title: string | null = null

    if (response.isText && /html/i.test(response.contentType)) {
      try {
        const doc = createParser().parseHtml(response.text)
        const raw = doc.selectAll('title')[0]?.text() ?? ''
        title = raw.trim() || null
      } catch {
        title = null
      }
    }

    return {
      ok: response.ok,
      url,
      finalUrl: response.finalUrl,
      statusCode: response.status,
      elapsedMs: response.elapsedMs,
      contentType: response.contentType || null,
      title,
      message: response.ok ? '连接成功' : `目标返回 HTTP ${response.status}`,
    }
  } catch (error) {
    const message =
      error instanceof RequestError ? `${error.code}：${error.message}` : error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      url,
      finalUrl: null,
      statusCode: null,
      elapsedMs: Math.round(performance.now() - startedAt),
      contentType: null,
      title: null,
      message,
    }
  }
}
