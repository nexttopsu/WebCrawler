import { jsonOk } from '../lib/response.js'
import { parseQuery } from '../lib/validation.js'
import { listLogs, logListQuerySchema } from '../services/log-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/** 日志查询。写入在采集过程中完成，这里只读。 */
export function logRoutes(_deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/logs',
      handler: (event) => jsonOk(event, listLogs(parseQuery(event, logListQuerySchema))),
    },
  ]
}
