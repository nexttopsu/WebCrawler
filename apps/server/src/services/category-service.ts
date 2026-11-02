import { getModels, type CategoryRow } from '@webcrawler/database'
import type { CategoryDetailDto, CategoryDto, PaginatedData } from '@webcrawler/shared'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import {
  assertProxyUsable,
  findCategoryOrThrow,
  findRuleOrThrow,
  findSiteOrThrow,
  textOrNull,
  toCategoryDto,
  toProxySummary,
  toRuleSummary,
} from './common.js'

const CATEGORY_COLUMNS =
  'id, siteId, name, code, listUrl, ruleId, proxyId, enabled, crawlInterval, sortOrder, description, createdAt, updatedAt'

const idField = z.number().int().positive()
const listUrlField = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), '列表地址必须是 http(s) 绝对地址')

export const categoryCreateSchema = z
  .object({
    siteId: idField,
    name: z.string().trim().min(1).max(100),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, '栏目编号只能包含字母、数字、下划线与短横线')
      .nullable()
      .optional(),
    listUrl: listUrlField,
    ruleId: idField.nullable().optional(),
    proxyId: idField.nullable().optional(),
    enabled: z.boolean().optional(),
    crawlInterval: z.number().int().min(0).max(2_592_000).optional(),
    sortOrder: z.number().int().min(-9999).max(9999).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()

/** PUT：除站点外全部字段可替换；站点归属不可变更（避免破坏文章与任务的引用）。 */
export const categoryReplaceSchema = categoryCreateSchema.omit({ siteId: true })

/** PATCH：任意子集。 */
export const categoryPatchSchema = categoryReplaceSchema.partial()

export const categoryListQuerySchema = z.object({
  ...paginationFields,
  siteId: z.coerce.number().int().positive().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  keyword: keywordField,
})

export const categoryStatusSchema = z.object({ enabled: z.boolean() }).strict()

export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>
export type CategoryPatchInput = z.infer<typeof categoryPatchSchema>
export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>

/** 栏目列表：按站点、启用状态与关键词筛选。 */
export function listCategories(query: CategoryListQuery): PaginatedData<CategoryDto> {
  const conditions: string[] = []
  const params: Array<string | number | null> = []

  if (query.siteId) {
    conditions.push('siteId = ?')
    params.push(query.siteId)
  }
  if (query.enabled) {
    conditions.push('enabled = ?')
    params.push(query.enabled === 'true' ? 1 : 0)
  }
  if (query.keyword) {
    const pattern = likePattern(query.keyword)
    conditions.push(`(name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR listUrl LIKE ? ESCAPE '\\')`)
    params.push(pattern, pattern, pattern)
  }

  const { rows, total } = runRawList<CategoryRow>(getModels().category.db, {
    select: CATEGORY_COLUMNS,
    from: 'category',
    conditions,
    params,
    orderBy: 'sortOrder ASC, id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toCategoryDto), total, query.page, query.pageSize)
}

/** 栏目详情：附带站点、规则与代理摘要（代理不含凭据）。 */
export function getCategory(id: number): CategoryDetailDto {
  const category = findCategoryOrThrow(id)
  const models = getModels()
  const site = models.site.findById(category.siteId ?? 0)
  if (!site) throw new NotFoundError(`栏目 ${id} 所属站点不存在`)

  const rule = category.ruleId ? models.crawlRule.findById(category.ruleId) : undefined
  const proxy = category.proxyId ? models.proxy.findById(category.proxyId) : undefined

  return {
    ...toCategoryDto(category),
    site: { id: site.id, name: site.name ?? '', domain: site.domain ?? '' },
    rule: rule ? toRuleSummary(rule) : null,
    proxy: proxy ? toProxySummary(proxy) : null,
  }
}

/** 校验规则可被该站点的栏目引用。 */
function assertRuleInSite(ruleId: number, siteId: number): void {
  const rule = findRuleOrThrow(ruleId)
  if (rule.siteId !== siteId) {
    throw new ValidationError('规则必须属于该栏目所在的站点', [
      { path: 'ruleId', message: '规则不属于该站点', code: 'invalid_value' },
    ])
  }
}

/** 同一站点内的编号与列表地址必须唯一（数据库唯一索引是最后防线）。 */
function assertCategoryUnique(
  siteId: number,
  fields: { code?: string | null; listUrl?: string },
  excludeId?: number,
): void {
  const models = getModels()

  if (fields.code) {
    const existing = models.category.findOne({ siteId, code: fields.code })
    if (existing && existing.id !== excludeId) {
      throw new ConflictError(`栏目编号 ${fields.code} 在该站点已存在`, {
        field: 'code',
        categoryId: existing.id,
      })
    }
  }

  if (fields.listUrl) {
    const existing = models.category.findOne({ siteId, listUrl: fields.listUrl })
    if (existing && existing.id !== excludeId) {
      throw new ConflictError('该列表地址已被同一站点的其他栏目使用', {
        field: 'listUrl',
        categoryId: existing.id,
      })
    }
  }
}

/** 创建栏目。 */
export function createCategory(input: CategoryCreateInput): CategoryDto {
  const site = findSiteOrThrow(input.siteId)
  const code = textOrNull(input.code)

  assertCategoryUnique(input.siteId, { code, listUrl: input.listUrl })
  if (input.ruleId) assertRuleInSite(input.ruleId, input.siteId)
  if (input.proxyId) assertProxyUsable(input.proxyId)

  const created = getModels().category.create({
    siteId: site.id,
    name: input.name,
    code,
    listUrl: input.listUrl,
    ruleId: input.ruleId ?? null,
    proxyId: input.proxyId ?? null,
    enabled: (input.enabled ?? true) ? 1 : 0,
    crawlInterval: input.crawlInterval ?? 3600,
    sortOrder: input.sortOrder ?? 0,
    description: textOrNull(input.description),
  })

  return toCategoryDto(created)
}

/**
 * 更新栏目。
 *
 * `replace=true`（PUT）时未提供的可选字段重置为空（启用状态重置为启用）；
 * 站点归属不可变更。
 */
export function updateCategory(id: number, input: CategoryPatchInput, replace = false): CategoryDto {
  const current = findCategoryOrThrow(id)
  const siteId = current.siteId ?? 0
  const code = input.code === undefined ? (replace ? null : current.code) : textOrNull(input.code)
  const listUrl = input.listUrl ?? current.listUrl ?? ''

  if (!listUrl) throw new ValidationError('listUrl 不能为空')
  assertCategoryUnique(siteId, { code, listUrl }, id)

  if (input.ruleId) assertRuleInSite(input.ruleId, siteId)
  if (input.proxyId) assertProxyUsable(input.proxyId)

  const updated = getModels().category.update(id, {
    name: input.name ?? current.name,
    code,
    listUrl,
    ruleId:
      input.ruleId === undefined ? (replace ? null : current.ruleId) : (input.ruleId ?? null),
    proxyId:
      input.proxyId === undefined ? (replace ? null : current.proxyId) : (input.proxyId ?? null),
    enabled: input.enabled === undefined ? (replace ? 1 : (current.enabled ?? 0)) : input.enabled ? 1 : 0,
    crawlInterval:
      input.crawlInterval === undefined ? (replace ? 3600 : (current.crawlInterval ?? 0)) : input.crawlInterval,
    sortOrder: input.sortOrder === undefined ? (replace ? 0 : (current.sortOrder ?? 0)) : input.sortOrder,
    description: replace
      ? textOrNull(input.description)
      : input.description === undefined
        ? current.description
        : textOrNull(input.description),
  })

  if (!updated) throw new NotFoundError(`栏目 ${id} 不存在`)
  return toCategoryDto(updated)
}

/** 启用 / 禁用栏目。 */
export function setCategoryEnabled(id: number, enabled: boolean): CategoryDto {
  const updated = getModels().category.update(id, { enabled: enabled ? 1 : 0 })
  if (!updated) throw new NotFoundError(`栏目 ${id} 不存在`)
  return toCategoryDto(updated)
}

/**
 * 删除栏目。
 *
 * 存在文章或采集任务时一律拒绝：这两类数据是采集结果，
 * 不做「删栏目顺带删文章」的无提示级联。
 */
export function deleteCategory(id: number): { id: number } {
  const category = findCategoryOrThrow(id)
  const models = getModels()

  const counts = {
    articles: models.article.count({ categoryId: id }),
    tasks: models.crawlTask.count({ categoryId: id }),
  }

  if (counts.articles > 0 || counts.tasks > 0) {
    throw new ConflictError('栏目下存在文章或采集任务，无法删除；请先清理数据或改为禁用', {
      categoryId: id,
      counts,
    })
  }

  models.category.delete(category.id)
  return { id }
}
