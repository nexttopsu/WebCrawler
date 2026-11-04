import {
  getDatabaseContext,
  getModels,
  type CategoryRow,
  type CrawlTaskRow,
  type SiteRow,
} from '../../database/index.js'
import {
  canTransition,
  CrawlTaskStatus,
  CrawlTaskTrigger,
  CrawlTaskType,
  describeInvalidTransition,
  formatRuleIssues,
  parseRuleConfig,
  type CrawlRuleConfig,
  type TaskCategorySnapshot,
  type TaskCheckpoint,
  type TaskConfigSnapshot,
  type TaskDetailDto,
  type TaskDto,
  type TaskOptions,
  type TaskProgressDto,
} from '../../shared/index.js'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import { findCategoryOrThrow, findSiteOrThrow, textOrNull } from './common.js'
import { writeLog } from './log-service.js'
import { resolveEffectiveRule } from './rule-service.js'

/* -------------------------------------------------------------------------- */
/* 输入 Schema                                                                 */
/* -------------------------------------------------------------------------- */

const idField = z.number().int().positive()
const isoTimeField = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), '时间格式不合法，请使用 ISO 8601')
  .transform((value) => new Date(value).toISOString())

export const taskOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(10_000).optional(),
    maxPages: z.number().int().min(1).max(500).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    rateLimitMs: z.number().int().min(0).max(60_000).optional(),
    publishedAfter: isoTimeField.optional(),
    publishedBefore: isoTimeField.optional(),
    incremental: z.boolean().optional(),
    maxDurationMs: z.number().int().min(1_000).max(86_400_000).optional(),
    followPagination: z.boolean().optional(),
  })
  .strict()

export const taskCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    siteId: idField,
    type: z.enum(['site', 'category', 'batch', 'urls', 'full', 'incremental', 'list', 'detail']),
    categoryIds: z.array(idField).max(200).optional(),
    urls: z.array(z.string().trim().url().max(2048)).min(1).max(500).optional(),
    ruleOverride: z.unknown().optional(),
    options: taskOptionsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count = value.categoryIds?.length ?? 0
    if (value.type === 'category' && count !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryIds'],
        message: 'category 类型必须且只能指定一个栏目',
      })
    }
    if (value.type === 'batch' && count < 1) {
      ctx.addIssue({ code: 'custom', path: ['categoryIds'], message: 'batch 类型至少需要一个栏目' })
    }
    if (value.type === 'urls') {
      if (!value.urls?.length) {
        ctx.addIssue({ code: 'custom', path: ['urls'], message: 'urls 类型必须提供至少一个地址' })
      }
      if (count > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['categoryIds'],
          message: 'urls 类型最多关联一个栏目（用于提供规则与代理）',
        })
      }
    }
    if (value.type !== 'urls' && value.urls?.length) {
      ctx.addIssue({ code: 'custom', path: ['urls'], message: '仅 urls 类型可以指定 urls' })
    }
  })

export const taskListQuerySchema = z.object({
  ...paginationFields,
  siteId: z.coerce.number().int().positive().optional(),
  scheduleId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']).optional(),
  type: z.enum(['site', 'category', 'batch', 'urls', 'full', 'incremental', 'list', 'detail']).optional(),
  trigger: z.enum(['manual', 'schedule', 'retry']).optional(),
  keyword: keywordField,
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

export type TaskCreateInput = z.infer<typeof taskCreateSchema>
export type TaskListQuery = z.infer<typeof taskListQuerySchema>

/** 创建任务时由运行时提供的默认值。 */
export interface TaskDefaults {
  rateLimitMs: number
  maxDurationMs: number
  retries: number
}

const DEFAULT_TASK_OPTIONS: TaskDefaults = {
  rateLimitMs: 300,
  maxDurationMs: 30 * 60 * 1000,
  retries: 1,
}

const TYPE_LABEL: Record<CrawlTaskType, string> = {
  site: '站点采集',
  category: '栏目采集',
  batch: '批量栏目采集',
  urls: '指定 URL 采集',
  full: '全量采集',
  incremental: '增量采集',
  list: '仅列表采集',
  detail: '详情补采',
}

/* -------------------------------------------------------------------------- */
/* 行 → 快照 / DTO                                                             */
/* -------------------------------------------------------------------------- */

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function parseTaskSnapshot(raw: string | null): TaskConfigSnapshot | null {
  const value = parseJson<TaskConfigSnapshot | null>(raw, null)
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value.categories) || typeof value.siteId !== 'number') return null
  return value
}

export function parseTaskCheckpoint(raw: string | null): TaskCheckpoint | null {
  const value = parseJson<TaskCheckpoint | null>(raw, null)
  if (!value || typeof value !== 'object' || !Array.isArray(value.processedUrls)) return null
  return value
}

/** 历史数据里的 success / canceled 统一到新枚举。 */
export function normalizeTaskStatus(raw: string | null): CrawlTaskStatus {
  switch (raw) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw
    case 'success':
      return CrawlTaskStatus.COMPLETED
    case 'canceled':
      return CrawlTaskStatus.CANCELLED
    default:
      return CrawlTaskStatus.FAILED
  }
}

function toProgress(row: CrawlTaskRow): TaskProgressDto {
  const total = row.totalCount ?? 0
  const success = row.successCount ?? 0
  const failed = row.failedCount ?? row.failCount ?? 0
  const skipped = row.skippedCount ?? 0
  const processed = success + failed + skipped
  const status = normalizeTaskStatus(row.status)
  const percent =
    total > 0
      ? Math.min(100, Math.round((processed / total) * 100))
      : status === CrawlTaskStatus.COMPLETED
        ? 100
        : 0

  return {
    total,
    success,
    failed,
    skipped,
    currentPage: row.currentPage ?? 0,
    totalPages: row.totalPages ?? 0,
    percent,
  }
}

interface TaskListRow extends CrawlTaskRow {
  siteName?: string | null
}

export function toTaskDto(row: TaskListRow): TaskDto {
  return {
    id: row.id,
    name: row.name ?? '',
    siteId: row.siteId ?? 0,
    siteName: textOrNull(row.siteName ?? null),
    categoryIds: parseJson<number[]>(row.categoryIds, row.categoryId ? [row.categoryId] : []),
    type: (row.type ?? 'category') as CrawlTaskType,
    status: normalizeTaskStatus(row.status),
    trigger: (row.trigger ?? 'manual') as CrawlTaskTrigger,
    scheduleId: row.scheduleId ?? null,
    progress: toProgress(row),
    options: parseTaskSnapshot(row.configSnapshot)?.options ?? {},
    attempts: row.attempts ?? 0,
    errorSummary: row.errorSummary,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

function toTaskDetailDto(row: CrawlTaskRow): TaskDetailDto {
  const snapshot = parseTaskSnapshot(row.configSnapshot)
  const base = toTaskDto(row)
  return {
    ...base,
    options: snapshot?.options ?? {},
    categories: (snapshot?.categories ?? []).map((item) => ({
      id: item.categoryId,
      name: item.name,
      listUrl: item.listUrl,
    })),
    configSnapshot: snapshot,
    checkpoint: parseTaskCheckpoint(row.checkpoint),
  }
}

/* -------------------------------------------------------------------------- */
/* 快照构建                                                                    */
/* -------------------------------------------------------------------------- */

export interface BuiltSnapshot {
  snapshot: TaskConfigSnapshot
  site: SiteRow
  categoryRows: CategoryRow[]
  primaryRule: { ruleId: number | null; version: number; config: CrawlRuleConfig }
}

function assertCategoryEnabled(category: CategoryRow): void {
  if (category.enabled !== 1) {
    throw new ConflictError(`栏目「${category.name ?? category.id}」已禁用，不能创建采集任务`, {
      categoryId: category.id,
    })
  }
}

function requireRuleConfig(config: CrawlRuleConfig | null, label: string, needList: boolean): CrawlRuleConfig {
  if (!config) {
    throw new ValidationError(`${label}没有可用规则，请先配置站点默认规则或栏目规则`)
  }
  const parsed = parseRuleConfig(config)
  if (!parsed.success) {
    throw new ValidationError(`${label}的规则配置不合法：${formatRuleIssues(parsed.issues)}`, parsed.issues)
  }
  if (needList && !parsed.config.list?.itemSelector) {
    throw new ValidationError(`${label}的规则缺少 list.itemSelector，无法抓取列表页`)
  }
  if (!needList && Object.keys(parsed.config.detail?.fields ?? parsed.config.fields ?? {}).length === 0) {
    throw new ValidationError(`${label}的规则缺少详情字段（detail.fields），无法提取文章`)
  }
  return parsed.config
}

/**
 * 生成任务快照。
 *
 * 规则在此刻完成「站点默认 < 栏目 < 任务覆盖」合并与校验：
 * 任务运行期间再改规则、改栏目、删规则，都不会影响已排队任务。
 */
export function buildTaskSnapshot(
  input: TaskCreateInput,
  defaults: TaskDefaults = DEFAULT_TASK_OPTIONS,
): BuiltSnapshot {
  const site = findSiteOrThrow(input.siteId)
  if (site.status === 'inactive') {
    throw new ConflictError(`站点「${site.name ?? site.id}」已停用，不能创建采集任务`, {
      siteId: site.id,
    })
  }

  const options = normalizeOptions(input.options, input.type, defaults)
  const allCategories = getModels().category.findMany({ siteId: site.id })

  let categoryRows: CategoryRow[] = []
  if (input.type === CrawlTaskType.URLS) {
    categoryRows = input.categoryIds?.length
      ? [findCategoryOrThrow(input.categoryIds[0]!)]
      : []
    for (const category of categoryRows) {
      if (category.siteId !== site.id) {
        throw new ValidationError('栏目不属于该站点', [{ path: 'categoryIds', message: '栏目不属于该站点' }])
      }
      assertCategoryEnabled(category)
    }
  } else if (input.type === CrawlTaskType.CATEGORY || input.type === CrawlTaskType.BATCH) {
    categoryRows = (input.categoryIds ?? []).map((id) => findCategoryOrThrow(id))
  } else if (input.categoryIds?.length) {
    categoryRows = input.categoryIds.map((id) => findCategoryOrThrow(id))
  } else {
    categoryRows = allCategories.filter((item) => item.enabled === 1)
    categoryRows.sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id - right.id)
  }

  for (const category of categoryRows) {
    if (category.siteId !== site.id) {
      throw new ValidationError(`栏目「${category.name ?? category.id}」不属于站点「${site.name ?? site.id}」`, [
        { path: 'categoryIds', message: `栏目 ${category.id} 不属于站点 ${site.id}` },
      ])
    }
    assertCategoryEnabled(category)
  }

  if (input.type !== CrawlTaskType.URLS && categoryRows.length === 0) {
    throw new ConflictError('没有可采集的启用栏目，请先添加栏目或指定 categoryIds', {
      siteId: site.id,
    })
  }

  // 详情补采不抓列表页，只要求规则里有详情字段
  const needList = input.type !== CrawlTaskType.URLS && input.type !== CrawlTaskType.DETAIL
  const categories: TaskCategorySnapshot[] = []
  let primaryRule: BuiltSnapshot['primaryRule'] | null = null

  for (const category of categoryRows) {
    const effective = resolveEffectiveRule({
      siteId: site.id,
      categoryId: category.id,
      ...(input.ruleOverride !== undefined ? { override: input.ruleOverride } : {}),
    })
    const config = requireRuleConfig(
      effective.config,
      `栏目「${category.name ?? category.id}」`,
      needList,
    )
    const source = effective.sources.at(-1)
    const proxyId = category.proxyId ?? site.defaultProxyId ?? null
    categories.push({
      categoryId: category.id,
      name: category.name ?? `栏目 ${category.id}`,
      listUrl: config.list?.url?.trim() || category.listUrl || '',
      ruleId: source?.ruleId ?? null,
      ruleVersion: source?.version ?? 1,
      config,
      proxyId,
    })
    primaryRule ??= { ruleId: source?.ruleId ?? null, version: source?.version ?? 1, config }
  }

  if (input.type === CrawlTaskType.URLS && categories.length === 0) {
    const effective = resolveEffectiveRule({
      siteId: site.id,
      ...(input.ruleOverride !== undefined ? { override: input.ruleOverride } : {}),
    })
    const config = requireRuleConfig(effective.config, '站点默认规则', false)
    const source = effective.sources.at(-1)
    categories.push({
      categoryId: 0,
      name: '指定 URL',
      listUrl: '',
      ruleId: source?.ruleId ?? null,
      ruleVersion: source?.version ?? 1,
      config,
      proxyId: site.defaultProxyId ?? null,
    })
  }

  primaryRule ??= {
    ruleId: categories[0]?.ruleId ?? null,
    version: categories[0]?.ruleVersion ?? 1,
    config: categories[0]!.config,
  }

  return {
    site,
    categoryRows,
    primaryRule,
    snapshot: {
      siteId: site.id,
      siteName: site.name ?? '',
      baseUrl: site.baseUrl ?? '',
      categories,
      urls: input.urls ?? [],
      options,
    },
  }
}

function normalizeOptions(
  input: TaskOptions | undefined,
  type: CrawlTaskType,
  defaults: TaskDefaults,
): TaskOptions {
  const incremental = input?.incremental ?? type === CrawlTaskType.INCREMENTAL
  return {
    retries: defaults.retries,
    rateLimitMs: defaults.rateLimitMs,
    maxDurationMs: defaults.maxDurationMs,
    followPagination: true,
    ...input,
    incremental,
  }
}

/* -------------------------------------------------------------------------- */
/* 创建与查询                                                                  */
/* -------------------------------------------------------------------------- */

export function createTask(
  input: TaskCreateInput,
  options: {
    trigger?: CrawlTaskTrigger
    scheduleId?: number | null
    defaults?: TaskDefaults
  } = {},
): TaskDto {
  const { snapshot, site, primaryRule } = buildTaskSnapshot(input, options.defaults)
  const trigger = options.trigger ?? CrawlTaskTrigger.MANUAL
  const name = (input.name?.trim() || `${site.name ?? '站点'} ${TYPE_LABEL[input.type]}`).slice(0, 100)

  const created = getModels().crawlTask.create({
    name,
    siteId: site.id,
    categoryId: snapshot.categories.length === 1 ? snapshot.categories[0]!.categoryId : null,
    categoryIds: JSON.stringify(snapshot.categories.map((item) => item.categoryId)),
    ruleId: primaryRule.ruleId,
    type: input.type,
    status: CrawlTaskStatus.PENDING,
    trigger,
    scheduleId: options.scheduleId ?? null,
    configSnapshot: JSON.stringify(snapshot),
    ruleVersion: primaryRule.version,
    ruleSnapshot: JSON.stringify(primaryRule.config),
    totalCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    currentPage: 0,
    totalPages: 0,
    attempts: 0,
    checkpoint: null,
    errorSummary: null,
    startedAt: null,
    completedAt: null,
  })

  writeLog({
    taskId: created.id,
    siteId: site.id,
    level: 'info',
    stage: 'task',
    message: `任务已创建（${TYPE_LABEL[input.type]}，${snapshot.categories.length} 个栏目）`,
    detail: { trigger, type: input.type, categoryIds: snapshot.categories.map((item) => item.categoryId) },
  })

  return getTask(created.id)
}

export function getTaskRow(id: number): CrawlTaskRow {
  const row = getModels().crawlTask.findById(id)
  if (!row) throw new NotFoundError(`任务 ${id} 不存在`)
  return row
}

export function getTask(id: number): TaskDto {
  const row = getTaskRow(id)
  return toTaskDto({ ...row, siteName: findSiteName(row.siteId) } as TaskListRow)
}

export function getTaskDetail(id: number): TaskDetailDto {
  const row = getTaskRow(id)
  return toTaskDetailDto({ ...row, siteName: findSiteName(row.siteId) } as TaskListRow)
}

function findSiteName(siteId: number | null): string | null {
  if (!siteId) return null
  const site = getModels().site.findById(siteId)
  return site?.name ?? null
}

const TASK_COLUMNS = `t.*, (SELECT name FROM site WHERE site.id = t.siteId) AS siteName`

export function listTasks(query: TaskListQuery) {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.siteId) {
    conditions.push('t.siteId = ?')
    params.push(query.siteId)
  }
  if (query.scheduleId) {
    conditions.push('t.scheduleId = ?')
    params.push(query.scheduleId)
  }
  if (query.status) {
    conditions.push('t.status = ?')
    params.push(query.status)
  }
  if (query.type) {
    conditions.push('t.type = ?')
    params.push(query.type)
  }
  if (query.trigger) {
    conditions.push('t.trigger = ?')
    params.push(query.trigger)
  }
  if (query.keyword) {
    conditions.push("t.name LIKE ? ESCAPE '\\'")
    params.push(likePattern(query.keyword))
  }
  if (query.from) {
    conditions.push('t.createdAt >= ?')
    params.push(query.from)
  }
  if (query.to) {
    conditions.push('t.createdAt <= ?')
    params.push(query.to)
  }

  const { rows, total } = runRawList<TaskListRow>(getDatabaseContext().db, {
    select: TASK_COLUMNS,
    from: 'crawl_task t',
    conditions,
    params,
    orderBy: 't.id DESC',
    page: query.page,
    pageSize: query.pageSize,
  })

  return toPage(rows.map(toTaskDto), total, query.page, query.pageSize)
}

/* -------------------------------------------------------------------------- */
/* 状态流转                                                                    */
/* -------------------------------------------------------------------------- */

export interface TaskPatch {
  status?: CrawlTaskStatus
  totalCount?: number
  successCount?: number
  failedCount?: number
  skippedCount?: number
  currentPage?: number
  totalPages?: number
  checkpoint?: string | null
  errorSummary?: string | null
  startedAt?: string | null
  completedAt?: string | null
  attempts?: number
  scheduleId?: number | null
  name?: string
}

/** 直接更新任务行，不校验状态；仅供执行器在已知合法路径下使用。 */
export function patchTask(id: number, patch: TaskPatch): void {
  getModels().crawlTask.update(id, patch)
}

/** 带状态机校验的更新：非法转换抛 409。 */
export function transitionTask(
  id: number,
  target: CrawlTaskStatus,
  patch: TaskPatch = {},
): CrawlTaskRow {
  const row = getTaskRow(id)
  const from = normalizeTaskStatus(row.status)

  if (from !== target && !canTransition(from, target)) {
    throw new ConflictError(describeInvalidTransition(from, target) ?? '状态转换不合法', {
      taskId: id,
      from,
      to: target,
    })
  }

  getModels().crawlTask.update(id, { ...patch, status: target })
  return getTaskRow(id)
}

export function pauseTask(id: number): TaskDto {
  transitionTask(id, CrawlTaskStatus.PAUSED)
  writeLog({ taskId: id, level: 'info', stage: 'task', message: '任务已暂停' })
  return getTask(id)
}

export function resumeTask(id: number): TaskDto {
  transitionTask(id, CrawlTaskStatus.PENDING)
  writeLog({ taskId: id, level: 'info', stage: 'task', message: '任务已恢复，重新排队' })
  return getTask(id)
}

export function cancelTask(id: number): TaskDto {
  transitionTask(id, CrawlTaskStatus.CANCELLED, {
    completedAt: new Date().toISOString(),
    errorSummary: '任务已被取消',
  })
  writeLog({ taskId: id, level: 'warn', stage: 'task', message: '任务已取消' })
  return getTask(id)
}

/** 重试：终态 → pending，保留断点以便跳过已处理 URL。 */
export function retryTask(id: number): TaskDto {
  const row = getTaskRow(id)
  const status = normalizeTaskStatus(row.status)
  if (status !== CrawlTaskStatus.FAILED && status !== CrawlTaskStatus.CANCELLED) {
    throw new ConflictError(`只有 failed / cancelled 状态的任务可以重试，当前状态：${status}`, {
      taskId: id,
      status,
    })
  }

  // 不在这里递增 attempts：执行器开始运行时统一 +1，避免重复计数
  transitionTask(id, CrawlTaskStatus.PENDING, {
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    totalCount: 0,
    currentPage: 0,
    completedAt: null,
    startedAt: null,
    errorSummary: null,
  })
  writeLog({ taskId: id, level: 'info', stage: 'task', message: '任务已重新排队（重试）' })
  return getTask(id)
}

/** 删除任务：只允许终态，避免删掉正在执行的任务。 */
export function deleteTask(id: number): { deleted: boolean } {
  const row = getTaskRow(id)
  const status = normalizeTaskStatus(row.status)
  if (status === CrawlTaskStatus.RUNNING || status === CrawlTaskStatus.PENDING) {
    throw new ConflictError('运行中或排队中的任务不能删除，请先取消', { taskId: id, status })
  }
  getModels().crawlTask.delete(id)
  writeLog({ taskId: null, siteId: row.siteId, level: 'info', stage: 'task', message: `任务 ${id} 已删除` })
  return { deleted: true }
}

/* -------------------------------------------------------------------------- */
/* 统计与调度辅助                                                              */
/* -------------------------------------------------------------------------- */

/** 统计某个状态下、可被调度的任务。 */
export function findRunnableTaskIds(): number[] {
  const rows = getModels()
    .crawlTask.findMany({ status: CrawlTaskStatus.PENDING }, { orderBy: 'id', order: 'ASC' })
  return rows.map((row) => row.id)
}

/** 同一站点是否有排队/运行中的任务（定时任务防重复用）。 */
export function hasActiveTaskForSite(siteId: number): boolean {
  const models = getModels()
  return (
    models.crawlTask.count({ siteId, status: CrawlTaskStatus.PENDING }) > 0 ||
    models.crawlTask.count({ siteId, status: CrawlTaskStatus.RUNNING }) > 0 ||
    models.crawlTask.count({ siteId, status: CrawlTaskStatus.PAUSED }) > 0
  )
}

/**
 * 是否有覆盖同一批栏目的活动任务。
 *
 * 定时任务防重复的核心：同一栏目上已有排队/运行中的任务时，
 * 不再创建新任务，避免对同一列表页重复施压、重复写入。
 */
export function hasActiveTaskForCategories(siteId: number, categoryIds: number[]): boolean {
  const models = getModels()
  const active = [
    ...models.crawlTask.findMany({ siteId, status: CrawlTaskStatus.PENDING }),
    ...models.crawlTask.findMany({ siteId, status: CrawlTaskStatus.RUNNING }),
    ...models.crawlTask.findMany({ siteId, status: CrawlTaskStatus.PAUSED }),
  ]
  if (active.length === 0) return false

  const targets = new Set(categoryIds)
  for (const row of active) {
    const type = (row.type ?? '') as string
    if (!categoryIds.length || type === 'site' || type === 'full' || type === 'incremental') return true
    const covered = parseJson<number[]>(row.categoryIds, row.categoryId ? [row.categoryId] : [])
    if (covered.some((id) => targets.has(id))) return true
  }
  return false
}

/** 某个定时配置是否有排队/运行中的任务。 */
export function hasActiveTaskForSchedule(scheduleId: number): boolean {
  const models = getModels()
  return (
    models.crawlTask.count({ scheduleId, status: CrawlTaskStatus.PENDING }) > 0 ||
    models.crawlTask.count({ scheduleId, status: CrawlTaskStatus.RUNNING }) > 0
  )
}

export function countTasksByStatus(): Record<string, number> {
  const rows = getModels().crawlTask.findMany({})
  const result: Record<string, number> = {}
  for (const row of rows) {
    const status = normalizeTaskStatus(row.status)
    result[status] = (result[status] ?? 0) + 1
  }
  return result
}
