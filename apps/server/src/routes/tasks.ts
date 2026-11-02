import { setHeader } from 'h3'
import { jsonOk } from '../lib/response.js'
import { parseBody, parseIdParam, parseQuery } from '../lib/validation.js'
import {
  deleteTask,
  getTaskDetail,
  listTasks,
  taskCreateSchema,
  taskListQuerySchema,
} from '../services/task-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/**
 * 任务接口。
 *
 * 创建后立即返回 201 + 任务 id，真正执行由后台 TaskRuntime 完成，
 * 不占用 HTTP 请求生命周期。
 */
export function taskRoutes(deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/tasks',
      handler: (event) => jsonOk(event, listTasks(parseQuery(event, taskListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/tasks',
      handler: async (event) => {
        const input = await parseBody(event, taskCreateSchema)
        const task = deps.runtime.createTask(input, { trigger: 'manual' })
        setHeader(event, 'location', `/api/tasks/${task.id}`)
        return jsonOk(event, task, 201)
      },
    },
    {
      method: 'GET',
      path: '/api/tasks/:id',
      handler: (event) => jsonOk(event, getTaskDetail(parseIdParam(event))),
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/pause',
      handler: (event) => jsonOk(event, deps.runtime.pause(parseIdParam(event))),
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/resume',
      handler: (event) => jsonOk(event, deps.runtime.resume(parseIdParam(event))),
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/cancel',
      handler: (event) => jsonOk(event, deps.runtime.cancel(parseIdParam(event))),
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/retry',
      handler: (event) => jsonOk(event, deps.runtime.retry(parseIdParam(event))),
    },
    {
      method: 'DELETE',
      path: '/api/tasks/:id',
      handler: (event) => jsonOk(event, deleteTask(parseIdParam(event))),
    },
  ]
}
