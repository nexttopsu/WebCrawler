import { z } from 'zod'
import { jsonOk } from '../lib/response.js'
import { parseQuery } from '../lib/validation.js'
import { buildOverview } from '../services/stats-service.js'
import type { ApiRoute } from './types.js'

const overviewQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
})

/**
 * 仪表盘统计。
 *
 * 一个接口返回看板需要的全部聚合数据：站点 / 栏目 / 文章 / 任务 / 代理计数、
 * 今日采集量、运行中任务、成功率、趋势、最近任务与最近错误。
 * 目的是避免前端首屏并发打十几个列表接口只为取 total。
 */
export function statsRoutes(): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/stats/overview',
      handler: (event) => {
        const { days } = parseQuery(event, overviewQuerySchema)
        return jsonOk(event, buildOverview(days))
      },
    },
  ]
}
