import { setHeader } from 'h3'
import { jsonOk } from '../lib/response.js'
import { parseBody, parseIdParam, parseOptionalBody, parseQuery } from '../lib/validation.js'
import {
  debugCaptureStartSchema,
  getDebugCaptureStatus,
  startDebugCapture,
  stopDebugCapture,
} from '../services/debug-capture-service.js'
import {
  createDebugSample,
  debugSampleCreateSchema,
  debugSampleDeleteQuerySchema,
  debugSampleListQuerySchema,
  debugSampleUpdateSchema,
  deleteDebugSample,
  deleteDebugSamples,
  getDebugSample,
  listDebugSamples,
  updateDebugSample,
} from '../services/debug-data-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/**
 * 调试数据 API。
 *
 * 列表刻意不返回 raw（原文可能几百 KB），编辑 / 查看单个条目时才取详情；
 * 删除支持「勾选批量」与「按筛选条件批量」两种，语义与日志中心一致。
 *
 * 另有三条 `capture/*` 接口：启动 / 停止一个有头浏览器，
 * 它访问的网页会实时写进同一张表（见 `debug-capture-service`）。
 */
export function debugDataRoutes(deps: ServiceDeps): ApiRoute[] {
  return [
    // 捕获浏览器：三段路径，必须排在 `/:id` 之前，避免被当成本条记录的 id
    {
      method: 'GET',
      path: '/api/debug-data/capture/status',
      handler: (event) => jsonOk(event, getDebugCaptureStatus()),
    },
    {
      method: 'POST',
      path: '/api/debug-data/capture/start',
      handler: async (event) => {
        const input = (await parseOptionalBody(event, debugCaptureStartSchema)) ?? {
          startUrl: null,
          includeJson: false,
          headless: false,
        }
        return jsonOk(event, await startDebugCapture(deps.config, input))
      },
    },
    {
      method: 'POST',
      path: '/api/debug-data/capture/stop',
      handler: async (event) => jsonOk(event, await stopDebugCapture()),
    },
    {
      method: 'GET',
      path: '/api/debug-data',
      handler: (event) => jsonOk(event, listDebugSamples(parseQuery(event, debugSampleListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/debug-data',
      handler: async (event) => {
        const input = await parseBody(event, debugSampleCreateSchema)
        const created = createDebugSample(input)
        setHeader(event, 'location', `/api/debug-data/${created.id}`)
        return jsonOk(event, created, 201)
      },
    },
    {
      method: 'GET',
      path: '/api/debug-data/:id',
      handler: (event) => jsonOk(event, getDebugSample(parseIdParam(event))),
    },
    {
      method: 'PUT',
      path: '/api/debug-data/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, debugSampleUpdateSchema)
        return jsonOk(event, updateDebugSample(id, input))
      },
    },
    {
      method: 'DELETE',
      path: '/api/debug-data/:id',
      handler: (event) => jsonOk(event, deleteDebugSample(parseIdParam(event))),
    },
    {
      // 批量删除：?ids=1,2,3 或按当前筛选条件（至少给一个条件）
      method: 'DELETE',
      path: '/api/debug-data',
      handler: (event) => jsonOk(event, deleteDebugSamples(parseQuery(event, debugSampleDeleteQuerySchema))),
    },
  ]
}
