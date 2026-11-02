import { getDatabaseContext, getModels, type CrawlScheduleRow } from '@webcrawler/database'
import {
  buildCronExpression,
  CrawlTaskStatus,
  isValidTimeZone,
  type CrawlTaskType,
  type ScheduleDto,
  type ScheduleFrequency,
  type TaskDto,
  type TaskOptions,
} from '@webcrawler/shared'
import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { isValidCron, nextRunAt } from '../lib/cron.js'
import { keywordField, likePattern, paginationFields, runRawList, toPage } from '../lib/query.js'
import { findCategoryOrThrow, findSiteOrThrow, textOrNull } from './common.js'
import { hasActiveTaskForCategories, hasActiveTaskForSchedule, taskOptionsSchema } from './task-service.js'
import type { TaskRuntime } from './task-runtime.js'
import { writeLog } from './log-service.js'
import { effectiveTimeZone } from './settings-service.js'

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

const scheduleInputBase = z.object({
  name: z.string().trim().min(1).max(100),
  siteId: z.number().int().positive(),
  categoryIds: z.array(z.number().int().positive()).max(200).optional(),
  taskType: z.enum(['site', 'category', 'batch', 'urls', 'full', 'incremental']).optional(),
  frequency: z.enum(['hourly', 'daily', 'weekly', 'cron']),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  cron: z.string().trim().max(120).optional(),
  timezone: z.string().trim().max(64).optional(),
  enabled: z.boolean().optional(),
  options: taskOptionsSchema.optional(),
  description: z.string().trim().max(500).nullable().optional(),
})

export const scheduleCreateSchema = scheduleInputBase.strict()
export const scheduleUpdateSchema = scheduleInputBase.partial().strict()
export const scheduleEnabledSchema = z.object({ enabled: z.boolean() }).strict()

export const scheduleListQuerySchema = z.object({
  ...paginationFields,
  siteId: z.coerce.number().int().positive().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  keyword: keywordField,
})

export type ScheduleCreateInput = z.infer<typeof scheduleCreateSchema>
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateSchema>
export type ScheduleListQuery = z.infer<typeof scheduleListQuerySchema>

/* -------------------------------------------------------------------------- */
/* 校验与映射                                                                  */
/* -------------------------------------------------------------------------- */

interface NormalizedCron {
  cron: string
  timezone: string
}

/** 把频率与时间字段翻译成 cron，并校验时区与表达式。 */
function normalizeCron(input: {
  frequency: ScheduleFrequency
  hour?: number
  minute?: number
  weekday?: number
  cron?: string
  timezone?: string
}): NormalizedCron {
  const timezone = input.timezone?.trim() || effectiveTimeZone()
  if (!isValidTimeZone(timezone)) {
    throw new ValidationError(`时区 ${timezone} 不是合法的 IANA 时区`, [
      { path: 'timezone', message: '请使用 Asia/Shanghai 这类 IANA 时区名', code: 'invalid_value' },
    ])
  }

  const cron = buildCronExpression({
    frequency: input.frequency,
    ...(input.hour !== undefined ? { hour: input.hour } : {}),
    ...(input.minute !== undefined ? { minute: input.minute } : {}),
    ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
    ...(input.cron !== undefined ? { cron: input.cron } : {}),
  })

  if (!cron) {
    const hint =
      input.frequency === 'daily'
        ? '每天执行需要提供 hour'
        : input.frequency === 'weekly'
          ? '每周执行需要提供 hour 与 weekday'
          : input.frequency === 'cron'
            ? '自定义频率需要提供 cron 表达式'
            : '无法生成 cron 表达式'
    throw new ValidationError(hint, [{ path: input.frequency === 'cron' ? 'cron' : 'hour', message: hint, code: 'invalid_value' }])
  }
  if (!isValidCron(cron)) {
    throw new ValidationError(`cron 表达式不合法：${cron}`, [
      { path: 'cron', message: '请使用 5 段 cron 表达式，例如 0 3 * * *', code: 'invalid_format' },
    ])
  }
  return { cron, timezone }
}

function assertCategoriesBelong(siteId: number, categoryIds: number[] | undefined): void {
  if (!categoryIds?.length) return
  for (const id of categoryIds) {
    const category = findCategoryOrThrow(id)
    if (category.siteId !== siteId) {
      throw new ValidationError(`栏目 ${id} 不属于站点 ${siteId}`, [
        { path: 'categoryIds', message: `栏目 ${id} 不属于该站点`, code: 'invalid_value' },
      ])
    }
  }
}

function parseOptions(raw: string | null): TaskOptions {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TaskOptions) : {}
  } catch {
    return {}
  }
}

function parseIds(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number') : []
  } catch {
    return []
  }
}

function toScheduleDto(row: CrawlScheduleRow, siteName: string | null): ScheduleDto {
  return {
    id: row.id,
    name: row.name ?? '',
    siteId: row.siteId ?? 0,
    siteName: textOrNull(siteName),
    categoryIds: parseIds(row.categoryIds),
    taskType: (row.taskType ?? 'site') as CrawlTaskType,
    frequency: (row.frequency ?? 'cron') as ScheduleFrequency,
    cron: row.cron ?? '',
    timezone: row.timezone ?? effectiveTimeZone(),
    enabled: row.enabled === 1,
    options: parseOptions(row.options),
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    lastTaskId: row.lastTaskId,
    description: row.description,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
  }
}

function findSiteName(siteId: number | null): string | null {
  if (!siteId) return null
  return getModels().site.findById(siteId)?.name ?? null
}

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

export function getScheduleRow(id: number): CrawlScheduleRow {
  const row = getModels().crawlSchedule.findById(id)
  if (!row) throw new NotFoundError(`定时任务 ${id} 不存在`)
  return row
}

export function getSchedule(id: number): ScheduleDto {
  const row = getScheduleRow(id)
  return toScheduleDto(row, findSiteName(row.siteId))
}

export function listSchedules(query: ScheduleListQuery) {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.siteId) {
    conditions.push('t.siteId = ?')
    params.push(query.siteId)
  }
  if (query.enabled) {
    conditions.push('t.enabled = ?')
    params.push(query.enabled === 'true' ? 1 : 0)
  }
  if (query.keyword) {
    conditions.push("t.name LIKE ? ESCAPE '\\'")
    params.push(likePattern(query.keyword))
  }

  const { rows, total } = runRawList<CrawlScheduleRow & { siteName: string | null }>(
    getDatabaseContext().db,
    {
      select: 't.*, (SELECT name FROM site WHERE site.id = t.siteId) AS siteName',
      from: 'crawl_schedule t',
      conditions,
      params,
      orderBy: 't.id DESC',
      page: query.page,
      pageSize: query.pageSize,
    },
  )

  return toPage(
    rows.map((row) => toScheduleDto(row, row.siteName)),
    total,
    query.page,
    query.pageSize,
  )
}

export function createSchedule(input: ScheduleCreateInput): ScheduleDto {
  const site = findSiteOrThrow(input.siteId)
  assertCategoriesBelong(site.id, input.categoryIds)

  if (getModels().crawlSchedule.findOne({ name: input.name })) {
    throw new ConflictError(`定时任务名称「${input.name}」已存在`, { name: input.name })
  }

  const taskType = (input.taskType ?? 'site') as CrawlTaskType
  const categoryIds = input.categoryIds ?? []
  if (taskType === 'category' && categoryIds.length !== 1) {
    throw new ValidationError('category 类型必须且只能指定一个栏目', [
      { path: 'categoryIds', message: '需要一个栏目', code: 'invalid_value' },
    ])
  }
  if (taskType === 'batch' && categoryIds.length === 0) {
    throw new ValidationError('batch 类型至少需要一个栏目', [
      { path: 'categoryIds', message: '至少一个栏目', code: 'invalid_value' },
    ])
  }
  if (taskType === 'urls') {
    throw new ValidationError('定时任务不支持 urls 类型（没有列表页可定期检查）', [
      { path: 'taskType', message: '请使用 site / category / batch / incremental', code: 'invalid_value' },
    ])
  }

  const { cron, timezone } = normalizeCron({
    frequency: input.frequency,
    ...(input.hour !== undefined ? { hour: input.hour } : {}),
    ...(input.minute !== undefined ? { minute: input.minute } : {}),
    ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
    ...(input.cron !== undefined ? { cron: input.cron } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  })

  const enabled = input.enabled ?? true
  const created = getModels().crawlSchedule.create({
    name: input.name,
    siteId: site.id,
    categoryIds: JSON.stringify(categoryIds),
    taskType,
    frequency: input.frequency,
    cron,
    timezone,
    enabled: enabled ? 1 : 0,
    options: JSON.stringify(input.options ?? {}),
    lastRunAt: null,
    nextRunAt: enabled ? nextRunAt(cron, timezone) : null,
    lastTaskId: null,
    description: input.description ?? null,
  })

  writeLog({
    siteId: site.id,
    level: 'info',
    stage: 'schedule',
    message: `定时任务「${input.name}」已创建（${cron}，${timezone}）`,
  })

  return toScheduleDto(created, site.name)
}

export function updateSchedule(id: number, input: ScheduleUpdateInput): ScheduleDto {
  const row = getScheduleRow(id)
  const siteId = input.siteId ?? row.siteId ?? 0
  if (input.siteId !== undefined) findSiteOrThrow(siteId)
  if (input.categoryIds !== undefined) assertCategoriesBelong(siteId, input.categoryIds)

  if (input.name && input.name !== row.name) {
    const existing = getModels().crawlSchedule.findOne({ name: input.name })
    if (existing && existing.id !== id) {
      throw new ConflictError(`定时任务名称「${input.name}」已存在`, { name: input.name })
    }
  }

  const frequency = (input.frequency ?? row.frequency ?? 'cron') as ScheduleFrequency
  const merged = {
    frequency,
    hour: input.hour ?? parseStoredHour(row.cron),
    minute: input.minute ?? parseStoredMinute(row.cron),
    weekday: input.weekday ?? parseStoredWeekday(row.cron),
    cron: input.cron ?? row.cron ?? '',
    timezone: input.timezone ?? row.timezone ?? effectiveTimeZone(),
  }
  const { cron, timezone } = normalizeCron({
    frequency,
    ...(merged.hour !== undefined ? { hour: merged.hour } : {}),
    ...(merged.minute !== undefined ? { minute: merged.minute } : {}),
    ...(merged.weekday !== undefined ? { weekday: merged.weekday } : {}),
    ...(input.cron !== undefined ? { cron: input.cron } : {}),
    ...(input.frequency === 'cron' ? { cron: merged.cron } : {}),
    timezone: merged.timezone,
  })

  const enabled = input.enabled ?? row.enabled === 1
  const updated = getModels().crawlSchedule.update(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.siteId !== undefined ? { siteId } : {}),
    ...(input.categoryIds !== undefined ? { categoryIds: JSON.stringify(input.categoryIds) } : {}),
    ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
    ...(input.options !== undefined ? { options: JSON.stringify(input.options) } : {}),
    frequency,
    cron,
    timezone,
    enabled: enabled ? 1 : 0,
    nextRunAt: enabled ? nextRunAt(cron, timezone) : null,
    ...(input.description !== undefined ? { description: input.description } : {}),
  })

  if (!updated) throw new NotFoundError(`定时任务 ${id} 不存在`)
  return toScheduleDto(updated, findSiteName(updated.siteId))
}

export function setScheduleEnabled(id: number, enabled: boolean): ScheduleDto {
  const row = getScheduleRow(id)
  const updated = getModels().crawlSchedule.update(id, {
    enabled: enabled ? 1 : 0,
    nextRunAt: enabled ? nextRunAt(row.cron ?? '', row.timezone ?? effectiveTimeZone()) : null,
  })
  writeLog({ siteId: row.siteId, level: 'info', stage: 'schedule', message: `定时任务「${row.name}」已${enabled ? '启用' : '禁用'}` })
  if (!updated) throw new NotFoundError(`定时任务 ${id} 不存在`)
  return toScheduleDto(updated, findSiteName(updated.siteId))
}

export function deleteSchedule(id: number): { deleted: boolean } {
  const row = getScheduleRow(id)
  getModels().crawlSchedule.delete(id)
  writeLog({ siteId: row.siteId, level: 'info', stage: 'schedule', message: `定时任务「${row.name}」已删除` })
  return { deleted: true }
}

/* -------------------------------------------------------------------------- */
/* 执行                                                                        */
/* -------------------------------------------------------------------------- */

export interface RunScheduleResult {
  task: TaskDto | null
  skipped: boolean
  reason?: string
}

/**
 * 到期执行：只创建正式任务，不在回调里跑采集。
 *
 * 同一栏目已有活动任务时跳过，避免定时器叠加造成重复抓取。
 */
export function runSchedule(
  id: number,
  runtime: TaskRuntime,
  trigger: 'schedule' | 'manual' = 'schedule',
): RunScheduleResult {
  const row = getScheduleRow(id)
  if (trigger === 'schedule' && row.enabled !== 1) {
    return { task: null, skipped: true, reason: '定时任务已禁用' }
  }
  if (hasActiveTaskForSchedule(id)) {
    writeLog({
      siteId: row.siteId,
      level: 'warn',
      stage: 'schedule',
      message: `定时任务「${row.name}」跳过：已有运行中的任务`,
    })
    return { task: null, skipped: true, reason: '已有运行中的任务' }
  }

  const categoryIds = parseIds(row.categoryIds)
  if (hasActiveTaskForCategories(row.siteId ?? 0, categoryIds)) {
    writeLog({
      siteId: row.siteId,
      level: 'warn',
      stage: 'schedule',
      message: `定时任务「${row.name}」跳过：同一栏目已有活动任务`,
    })
    return { task: null, skipped: true, reason: '同一栏目已有活动任务' }
  }

  const taskType = (row.taskType ?? 'site') as CrawlTaskType
  const now = new Date()
  const task = runtime.createTask(
    {
      name: `${row.name ?? '定时任务'} ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
      siteId: row.siteId ?? 0,
      type: taskType,
      ...(categoryIds.length > 0 ? { categoryIds } : {}),
      options: parseOptions(row.options),
    },
    { trigger: 'schedule', scheduleId: id },
  )

  getModels().crawlSchedule.update(id, {
    lastRunAt: now.toISOString(),
    lastTaskId: task.id,
    nextRunAt: row.enabled === 1 ? nextRunAt(row.cron ?? '', row.timezone ?? effectiveTimeZone()) : null,
  })

  writeLog({
    taskId: task.id,
    siteId: row.siteId,
    level: 'info',
    stage: 'schedule',
    message: `定时任务「${row.name}」触发，已创建任务 ${task.id}`,
  })

  return { task, skipped: false }
}

/* -------------------------------------------------------------------------- */
/* cron 反解（用于 PATCH 只改小时等场景）                                        */
/* -------------------------------------------------------------------------- */

function cronParts(cron: string | null): string[] {
  return (cron ?? '').trim().split(/\s+/)
}

function parseStoredMinute(cron: string | null): number | undefined {
  const value = Number(cronParts(cron)[0])
  return Number.isInteger(value) ? value : undefined
}

function parseStoredHour(cron: string | null): number | undefined {
  const value = Number(cronParts(cron)[1])
  return Number.isInteger(value) && cronParts(cron)[1] !== '*' ? value : undefined
}

function parseStoredWeekday(cron: string | null): number | undefined {
  const value = Number(cronParts(cron)[4])
  return Number.isInteger(value) && cronParts(cron)[4] !== '*' ? value : undefined
}

/** 供调度器刷新 nextRunAt 使用。 */
export function refreshNextRun(id: number): string | null {
  const row = getScheduleRow(id)
  if (row.enabled !== 1) {
    getModels().crawlSchedule.update(id, { nextRunAt: null })
    return null
  }
  const next = nextRunAt(row.cron ?? '', row.timezone ?? effectiveTimeZone())
  getModels().crawlSchedule.update(id, { nextRunAt: next })
  return next
}

/** 统计各状态任务数，供定时任务详情展示。 */
export function scheduleTaskCount(scheduleId: number): number {
  return getModels().crawlTask.count({ scheduleId, status: CrawlTaskStatus.COMPLETED })
}
