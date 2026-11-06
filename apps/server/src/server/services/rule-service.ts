import { getModels, type CrawlRuleRow } from '../../database/index.js'
import {
  formatRuleIssues,
  isDeepEqual,
  mergeRuleConfigChain,
  normalizeRuleConfig,
  parseRuleConfig,
  RULE_MERGE_STRATEGY,
  type CrawlRuleConfig,
  type EffectiveRuleDto,
  type PaginatedData,
  type RuleDto,
  type RuleSourceDto,
  type RuleVersionDetailDto,
  type RuleVersionDto,
} from '../../shared/index.js'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import {
  findCategoryOrThrow,
  findRuleOrThrow,
  findSiteOrThrow,
  parseStoredConfig,
  textOrNull,
  toRuleDto,
} from './common.js'

const RULE_COLUMNS =
  'id, siteId, categoryId, name, config, version, status, description, createdAt, updatedAt'

const idField = z.number().int().positive()

/** 创建规则：`config` 先按 unknown 接收，再由规则 Schema 校验并给出字段级错误。 */
export const ruleCreateSchema = z
  .object({
    siteId: idField,
    categoryId: idField.nullable().optional(),
    name: z.string().trim().min(1).max(100),
    config: z.unknown().optional(),
    status: z.enum(['enabled', 'disabled']).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()

/** PUT 的输入：名称与配置必填；未提供的可选字段重置为空。 */
export const ruleReplaceSchema = ruleCreateSchema.omit({ siteId: true }).extend({ config: z.unknown() })

/** PATCH 的输入：任意子集（含 siteId，用于把规则挪到另一个站点）。 */
export const rulePatchSchema = ruleCreateSchema.partial()

export const ruleListQuerySchema = z.object({
  ...paginationFields,
  siteId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
  scope: z.enum(['site', 'category']).optional(),
  keyword: keywordField,
})

export const ruleStatusSchema = z.object({ status: z.enum(['enabled', 'disabled']) }).strict()

/** 计算生效规则的输入。 */
export const resolveRuleSchema = z
  .object({
    siteId: idField,
    categoryId: idField.optional(),
    /** 任务临时覆盖：必须是完整合法的规则配置 */
    override: z.unknown().optional(),
  })
  .strict()

export type RuleCreateInput = z.infer<typeof ruleCreateSchema>
export type RulePatchInput = z.infer<typeof rulePatchSchema>
export type RuleListQuery = z.infer<typeof ruleListQuerySchema>
export type ResolveRuleInput = z.infer<typeof resolveRuleSchema>

/** 校验规则配置，失败时抛出带字段级信息的 400。 */
export function validateRuleConfig(input: unknown): CrawlRuleConfig {
  const result = parseRuleConfig(input)
  if (!result.success) {
    throw new ValidationError(`规则配置校验失败：${formatRuleIssues(result.issues)}`, result.issues)
  }
  return normalizeRuleConfig(result.config)
}

/** 规则列表：按站点、栏目、状态、作用域与关键词筛选。 */
export function listRules(query: RuleListQuery): PaginatedData<RuleDto> {
  const conditions: string[] = []
  const params: Array<string | number | null> = []

  if (query.siteId) {
    conditions.push('siteId = ?')
    params.push(query.siteId)
  }
  if (query.categoryId) {
    conditions.push('categoryId = ?')
    params.push(query.categoryId)
  }
  if (query.scope === 'site') conditions.push('categoryId IS NULL')
  if (query.scope === 'category') conditions.push('categoryId IS NOT NULL')
  if (query.status) {
    conditions.push('status = ?')
    params.push(query.status)
  }
  if (query.keyword) {
    const pattern = likePattern(query.keyword)
    conditions.push(`(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`)
    params.push(pattern, pattern)
  }

  const { rows, total } = runRawList<CrawlRuleRow>(getModels().crawlRule.db, {
    select: RULE_COLUMNS,
    from: 'crawl_rule',
    conditions,
    params,
    orderBy: 'id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toRuleDto), total, query.page, query.pageSize)
}

/** 规则详情（含当前版本的完整配置）。 */
export function getRule(id: number): RuleDto {
  return toRuleDto(findRuleOrThrow(id))
}

function assertRuleNameAvailable(siteId: number, name: string, excludeId?: number): void {
  const existing = getModels().crawlRule.findOne({ siteId, name })
  if (existing && existing.id !== excludeId) {
    throw new ConflictError(`规则名「${name}」在该站点已存在`, { field: 'name', ruleId: existing.id })
  }
}

/** 栏目归属校验：栏目必须存在且属于同一站点。 */
function assertCategoryForRule(categoryId: number, siteId: number): void {
  const category = findCategoryOrThrow(categoryId)
  if (category.siteId !== siteId) {
    throw new ValidationError('规则所属栏目必须属于同一站点', [
      { path: 'categoryId', message: '栏目不属于该站点', code: 'invalid_value' },
    ])
  }
}

/** 站点是否把该规则设为默认规则。 */
function isDefaultRuleOfSite(ruleId: number): boolean {
  return getModels().site.exists({ defaultRuleId: ruleId })
}

/** 创建规则：写入规则行与首个版本记录，两步在同一个事务内。 */
export function createRule(input: RuleCreateInput): RuleDto {
  const site = findSiteOrThrow(input.siteId)
  const config = validateRuleConfig(input.config ?? { version: 1 })
  const categoryId = input.categoryId ?? null

  assertRuleNameAvailable(site.id, input.name)
  if (categoryId !== null) assertCategoryForRule(categoryId, site.id)

  const models = getModels()
  let createdId = 0

  models.crawlRule.db.transaction(() => {
    const created = models.crawlRule.create({
      siteId: site.id,
      categoryId,
      name: input.name,
      config: JSON.stringify(config),
      version: 1,
      status: input.status ?? 'enabled',
      description: textOrNull(input.description),
    })
    createdId = created.id
    models.crawlRuleVersion.create({
      ruleId: created.id,
      version: 1,
      config: JSON.stringify(config),
      note: '创建规则',
    })
  })

  return getRule(createdId)
}

/**
 * 生成站点内唯一的副本名称：`原名 副本`、`原名 副本 2`……
 *
 * 名称上限 100 字符，先用截断后的原名，再逐级加序号，
 * 最终整体再截断一次，避免超长原名把后缀挤掉。
 */
function nextCopyName(siteId: number, sourceName: string): string {
  const suffix = ' 副本'
  const root = sourceName.slice(0, 96).trimEnd() || '规则'
  const models = getModels()

  let candidate = `${root}${suffix}`.slice(0, 100)
  let index = 2
  while (models.crawlRule.findOne({ siteId, name: candidate })) {
    candidate = `${root}${suffix} ${index}`.slice(0, 100)
    index += 1
    if (index > 100) {
      throw new ConflictError('该站点下的副本过多，请先整理已有规则', { siteId })
    }
  }
  return candidate
}

/**
 * 复制规则：按当前配置与归属创建一条新规则，名称自动加「副本」后缀并保证站点内唯一。
 *
 * 复制出的规则拥有独立的版本线（从 v1 开始），
 * 原规则的版本历史与引用关系都不会被带过去。
 */
export function duplicateRule(id: number): RuleDto {
  const source = findRuleOrThrow(id)
  const siteId = source.siteId ?? 0
  const config = normalizeRuleConfig(parseStoredConfig(source.config).config)

  return createRule({
    siteId,
    categoryId: source.categoryId ?? null,
    name: nextCopyName(siteId, source.name ?? ''),
    config,
    status: source.status === 'disabled' ? 'disabled' : 'enabled',
    description: source.description ?? null,
  })
}

/**
 * 更新规则。
 *
 * - 配置发生变化时修订号 +1，并追加一条版本记录（历史版本只读，不被覆盖）；
 * - 只改名称 / 描述 / 状态不产生新版本；
 * - 站点默认规则不能改成栏目规则。
 */
export function updateRule(id: number, input: RulePatchInput, replace = false): RuleDto {
  const current = findRuleOrThrow(id)
  const models = getModels()

  // 换站点：目标站点必须存在；站点默认规则不能挪走（否则旧站点的默认规则悬空）。
  const siteChanged = input.siteId !== undefined && input.siteId !== current.siteId
  if (siteChanged) {
    findSiteOrThrow(input.siteId as number)
    if (isDefaultRuleOfSite(id)) {
      throw new ConflictError('该规则是所在站点的默认规则，不能改到其它站点', { ruleId: id })
    }
  }
  const siteId = siteChanged ? (input.siteId as number) : (current.siteId ?? 0)

  const name = input.name ?? current.name ?? ''
  if (input.name !== undefined) assertRuleNameAvailable(siteId, name, id)

  // 换了站点而没显式指定栏目时，原栏目必然不属于新站点，直接解绑。
  const categoryId =
    input.categoryId === undefined
      ? replace || siteChanged
        ? null
        : current.categoryId
      : (input.categoryId ?? null)
  if (categoryId !== null) assertCategoryForRule(categoryId, siteId)
  if (categoryId !== null && isDefaultRuleOfSite(id)) {
    throw new ConflictError('该规则是站点的默认规则，不能设置为栏目规则', { ruleId: id })
  }

  const currentConfig = normalizeRuleConfig(parseStoredConfig(current.config).config)
  const nextConfig =
    input.config === undefined ? currentConfig : validateRuleConfig(input.config)
  const configChanged = input.config !== undefined && !isDeepEqual(currentConfig, nextConfig)

  const nextVersion = configChanged ? (current.version ?? 0) + 1 : (current.version ?? 1)

  models.crawlRule.db.transaction(() => {
    models.crawlRule.update(id, {
      siteId,
      name,
      categoryId,
      config: JSON.stringify(nextConfig),
      version: nextVersion,
      status: input.status ?? (replace ? 'enabled' : (current.status ?? 'enabled')),
      description: replace
        ? textOrNull(input.description)
        : input.description === undefined
          ? current.description
          : textOrNull(input.description),
    })

    if (configChanged) {
      models.crawlRuleVersion.create({
        ruleId: id,
        version: nextVersion,
        config: JSON.stringify(nextConfig),
        note: replace ? '整体替换配置' : '更新配置',
      })
    }
  })

  return getRule(id)
}

/** 启用 / 禁用规则。 */
export function setRuleStatus(id: number, status: 'enabled' | 'disabled'): RuleDto {
  const updated = getModels().crawlRule.update(id, { status })
  if (!updated) throw new NotFoundError(`规则 ${id} 不存在`)
  return toRuleDto(updated)
}

/**
 * 删除规则。
 *
 * 被栏目、站点默认规则或历史任务引用时默认拒绝，并在 `details` 中列出引用方。
 * `force=true` 会解除栏目与站点的引用后删除；历史任务永远保留引用。
 */
export function deleteRule(id: number, options: { force?: boolean } = {}): { id: number; detached: number } {
  const rule = findRuleOrThrow(id)
  const models = getModels()

  const categories = models.category.findMany({ ruleId: id })
  const sites = models.site.findMany({ defaultRuleId: id })
  const taskCount = models.crawlTask.count({ ruleId: id })

  if (taskCount > 0) {
    throw new ConflictError('该规则被历史采集任务引用，无法删除；请改为禁用', {
      ruleId: id,
      counts: { tasks: taskCount },
    })
  }

  if ((categories.length > 0 || sites.length > 0) && !options.force) {
    throw new ConflictError('该规则仍被栏目或站点默认规则引用，请先解除引用或使用 force=true', {
      ruleId: id,
      categories: categories.map((row) => ({ id: row.id, name: row.name })),
      sites: sites.map((row) => ({ id: row.id, name: row.name })),
    })
  }

  const detached = categories.length + sites.length

  models.crawlRule.db.transaction(() => {
    if (categories.length > 0) models.category.updateMany({ ruleId: id }, { ruleId: null })
    if (sites.length > 0) models.site.updateMany({ defaultRuleId: id }, { defaultRuleId: null })
    models.crawlRuleVersion.deleteMany({ ruleId: id })
    models.crawlRule.delete(rule.id)
  })

  return { id, detached }
}

/** 规则版本列表（新版本在前）。 */
export function listRuleVersions(id: number): RuleVersionDto[] {
  findRuleOrThrow(id)
  return getModels()
    .crawlRuleVersion.findMany({ ruleId: id }, { orderBy: 'version', order: 'DESC' })
    .map((row) => ({
      ruleId: id,
      version: row.version ?? 0,
      note: row.note,
      createdAt: row.createdAt ?? '',
    }))
}

/** 指定版本的完整配置（历史任务快照可据此复现）。 */
export function getRuleVersion(id: number, version: number): RuleVersionDetailDto {
  const rule = findRuleOrThrow(id)
  const row = getModels().crawlRuleVersion.findOne({ ruleId: id, version })

  if (!row) {
    const available = getModels()
      .crawlRuleVersion.findMany({ ruleId: id }, { select: ['version'], orderBy: 'version', order: 'ASC' })
      .map((item) => item.version)
    throw new NotFoundError(`规则 ${rule.id} 不存在版本 ${version}`, { available })
  }

  return {
    ruleId: id,
    version: row.version ?? 0,
    note: row.note,
    createdAt: row.createdAt ?? '',
    config: parseStoredConfig(row.config).config,
  }
}

/**
 * 计算生效规则。
 *
 * 优先级 `站点默认规则 < 规则侧绑定 < 栏目侧绑定 < 任务覆盖`，合并由 `mergeRuleConfigChain` 完成
 * （数组替换、对象与字段映射逐层合并，详见 `RULE_MERGE_STRATEGY`）。
 *
 * 「规则侧绑定」指规则自己的 `categoryId` 指向该栏目（采集规则页「绑定栏目」保存的就是它）；
 * 「栏目侧绑定」指栏目的 `ruleId` 指向规则（栏目管理的「采集规则」）。两者任一存在即可命中。
 */
export function resolveEffectiveRule(input: ResolveRuleInput): EffectiveRuleDto {
  const site = findSiteOrThrow(input.siteId)
  const sources: RuleSourceDto[] = []
  const configs: Array<CrawlRuleConfig | null> = []

  const defaultRule = site.defaultRuleId ? findByRuleIdOrThrow(site.defaultRuleId) : null
  if (defaultRule) {
    configs.push(readConfigOrThrow(defaultRule, '站点默认规则'))
    sources.push({
      scope: 'site',
      ruleId: defaultRule.id,
      name: defaultRule.name ?? '',
      version: defaultRule.version ?? 1,
    })
  }

  if (input.categoryId) {
    const category = findCategoryOrThrow(input.categoryId)
    if (category.siteId !== site.id) {
      throw new ValidationError('栏目不属于该站点', [
        { path: 'categoryId', message: '栏目不属于该站点', code: 'invalid_value' },
      ])
    }
    // 规则侧绑定：取该栏目下最近更新的规则（一般只有一条，多条时后保存的生效）
    const boundRule = getModels()
      .crawlRule.findMany({ categoryId: input.categoryId, siteId: site.id })
      .sort(
        (left, right) =>
          (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || right.id - left.id,
      )[0]
    if (boundRule) {
      configs.push(readConfigOrThrow(boundRule, '栏目规则'))
      sources.push({
        scope: 'category',
        ruleId: boundRule.id,
        name: boundRule.name ?? '',
        version: boundRule.version ?? 1,
      })
    }
    // 栏目侧绑定：栏目上显式选择的采集规则，优先级高于规则侧绑定
    if (category.ruleId && category.ruleId !== boundRule?.id) {
      const categoryRule = findByRuleIdOrThrow(category.ruleId)
      configs.push(readConfigOrThrow(categoryRule, '栏目规则'))
      sources.push({
        scope: 'category',
        ruleId: categoryRule.id,
        name: categoryRule.name ?? '',
        version: categoryRule.version ?? 1,
      })
    }
  }

  if (input.override !== undefined) {
    configs.push(validateRuleConfig(input.override))
    sources.push({ scope: 'task', ruleId: null, name: '任务临时覆盖', version: 1 })
  }

  const merged = mergeRuleConfigChain(configs)
  const pagination = merged?.list?.pagination ?? merged?.pagination

  return {
    siteId: site.id,
    categoryId: input.categoryId ?? null,
    config: merged,
    paginationType: pagination?.type ?? null,
    sources,
    mergeStrategy: RULE_MERGE_STRATEGY,
  }
}

function findByRuleIdOrThrow(id: number): CrawlRuleRow {
  const rule = getModels().crawlRule.findById(id)
  if (!rule) throw new NotFoundError(`规则 ${id} 不存在，请检查站点或栏目配置`)
  return rule
}

/** 读取已存配置并校验；损坏的数据要显式暴露，不能悄悄用默认值跑任务。 */
function readConfigOrThrow(row: CrawlRuleRow, label: string): CrawlRuleConfig {
  const parsed = parseRuleConfig(parseStoredConfig(row.config).config)
  if (!parsed.success) {
    throw new ValidationError(`${label}「${row.name ?? row.id}」的配置不合法：${formatRuleIssues(parsed.issues)}`, {
      ruleId: row.id,
      issues: parsed.issues,
    })
  }
  return normalizeRuleConfig(parsed.config)
}
