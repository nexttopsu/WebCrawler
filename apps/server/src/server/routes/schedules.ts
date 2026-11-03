import { setHeader } from 'h3'
import { jsonOk } from '../lib/response.js'
import { parseBody, parseIdParam, parseQuery } from '../lib/validation.js'
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  runSchedule,
  scheduleCreateSchema,
  scheduleEnabledSchema,
  scheduleListQuerySchema,
  scheduleUpdateSchema,
  setScheduleEnabled,
  updateSchedule,
} from '../services/schedule-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/**
 * 定时任务接口。
 *
 * 创建 / 修改 / 启停后立即同步调度器，避免「数据库改了、计时器还是旧的」。
 * 删除前先移除计时器，防止已删除的配置继续触发。
 *
 * PUT 按整体替换处理（必填字段必须齐全），PATCH 为局部更新。
 */
export function scheduleRoutes(deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/schedules',
      handler: (event) => jsonOk(event, listSchedules(parseQuery(event, scheduleListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/schedules',
      handler: async (event) => {
        const input = await parseBody(event, scheduleCreateSchema)
        const schedule = createSchedule(input)
        deps.scheduler.sync(schedule.id)
        setHeader(event, 'location', `/api/schedules/${schedule.id}`)
        return jsonOk(event, schedule, 201)
      },
    },
    {
      method: 'GET',
      path: '/api/schedules/:id',
      handler: (event) => jsonOk(event, getSchedule(parseIdParam(event))),
    },
    {
      method: 'PUT',
      path: '/api/schedules/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, scheduleCreateSchema)
        const schedule = updateSchedule(id, input)
        deps.scheduler.sync(schedule.id)
        return jsonOk(event, schedule)
      },
    },
    {
      method: 'PATCH',
      path: '/api/schedules/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const schedule = updateSchedule(id, await parseBody(event, scheduleUpdateSchema))
        deps.scheduler.sync(schedule.id)
        return jsonOk(event, schedule)
      },
    },
    {
      method: 'PATCH',
      path: '/api/schedules/:id/status',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, scheduleEnabledSchema)
        const schedule = setScheduleEnabled(id, input.enabled)
        if (schedule.enabled) deps.scheduler.sync(id)
        else deps.scheduler.remove(id)
        return jsonOk(event, schedule)
      },
    },
    {
      method: 'POST',
      path: '/api/schedules/:id/run',
      handler: (event) => {
        const id = parseIdParam(event)
        return jsonOk(event, runSchedule(id, deps.runtime, 'manual'))
      },
    },
    {
      method: 'DELETE',
      path: '/api/schedules/:id',
      handler: (event) => {
        const id = parseIdParam(event)
        deps.scheduler.remove(id)
        return jsonOk(event, deleteSchedule(id))
      },
    },
  ]
}
