import { getRouterParam } from 'h3'
import type { PluginRegistry } from '../../plugin-system/index.js'
import { z } from 'zod'
import { jsonOk } from '../lib/response.js'
import { parseOptionalBody, parseQuery } from '../lib/validation.js'
import {
  assertPluginName,
  getPlugin,
  listPluginErrors,
  listPlugins,
  pluginListQuerySchema,
  pluginStatusSchema,
  setPluginEnabled,
} from '../services/plugin-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

const errorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

/**
 * 插件管理。
 *
 * 插件全部内置：没有「扫描目录」「重建注册表」这类写操作，
 * 列表读内置清单 + 开关状态，启停直接作用于内存注册表并落库。
 */
export function pluginRoutes(deps: ServiceDeps, registry: PluginRegistry): ApiRoute[] {
  void deps
  return [
    {
      method: 'GET',
      path: '/api/plugins',
      handler: (event) => {
        const query = parseQuery(event, pluginListQuerySchema)
        return jsonOk(event, listPlugins(query, registry))
      },
    },
    {
      method: 'GET',
      path: '/api/plugins/:id',
      handler: (event) => jsonOk(event, getPlugin(assertPluginName(pluginId(event)), registry)),
    },
    {
      method: 'PATCH',
      path: '/api/plugins/:id/status',
      handler: async (event) => {
        const id = assertPluginName(pluginId(event))
        const input = await parseOptionalBody(event, pluginStatusSchema)
        if (!input) {
          const current = getPlugin(id, registry)
          return jsonOk(event, setPluginEnabled(id, !current.enabled, registry))
        }
        return jsonOk(event, setPluginEnabled(id, input.enabled, registry))
      },
    },
    {
      method: 'GET',
      path: '/api/plugins/:id/errors',
      handler: (event) => {
        const id = assertPluginName(pluginId(event))
        const { limit } = parseQuery(event, errorQuerySchema)
        return jsonOk(event, { items: listPluginErrors(id, limit) })
      },
    },
  ]
}

function pluginId(event: Parameters<ApiRoute['handler']>[0]): string {
  return getRouterParam(event, 'id') ?? ''
}
