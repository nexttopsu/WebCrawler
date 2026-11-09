import { jsonOk } from '../lib/response.js'
import { parseQuery } from '../lib/validation.js'
import { clearLogs, listLogs, logListQuerySchema } from '../services/log-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/**
 * 日志 API。写入在采集过程中完成；
 * 查询只读，删除支持按当前筛选条件批量清理（至少带一个条件）。
 */
export function logRoutes(_deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/logs',
      handler: (event) => jsonOk(event, listLogs(parseQuery(event, logListQuerySchema))),
    },
    {
      method: 'DELETE',
      path: '/api/logs',
      handler: (event) => jsonOk(event, clearLogs(parseQuery(event, logListQuerySchema))),
    },
  ]
}
