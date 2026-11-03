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
  refreshPlugins,
  scanPlugins,
  setPluginEnabled,
} from '../services/plugin-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

const errorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

const scanBodySchema = z
  .object({ directory: z.string().trim().min(1).max(500).optional() })
  .strict()

/**
 * 插件管理。
 *
 * 只有「清单登记 + 启停 + 扫描」——不联网安装、不做插件市场。
 * 扫描失败（清单非法 / 核心版本不兼容）逐条返回，且不会影响服务启动。
 */
export function pluginRoutes(deps: ServiceDeps, registry: PluginRegistry): ApiRoute[] {
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
      path: '/api/plugins/:name',
      handler: (event) => jsonOk(event, getPlugin(assertPluginName(pluginName(event)), registry)),
    },
    {
      method: 'PATCH',
      path: '/api/plugins/:name/status',
      handler: async (event) => {
        const name = assertPluginName(pluginName(event))
        const input = await parseOptionalBody(event, pluginStatusSchema)
        if (!input) {
          const current = getPlugin(name, registry)
          return jsonOk(event, await setPluginEnabled(name, !current.enabled, registry))
        }
        return jsonOk(event, await setPluginEnabled(name, input.enabled, registry))
      },
    },
    {
      method: 'GET',
      path: '/api/plugins/:name/errors',
      handler: (event) => {
        const name = assertPluginName(pluginName(event))
        const { limit } = parseQuery(event, errorQuerySchema)
        return jsonOk(event, { items: listPluginErrors(name, limit) })
      },
    },
    {
      method: 'POST',
      path: '/api/plugins/scan',
      handler: async (event) => {
        const body = (await parseOptionalBody(event, scanBodySchema)) ?? {}
        const directory = body.directory ?? deps.config.pluginDir
        const result = await scanPlugins(directory, registry)
        // 扫描后统一按「数据库启用状态」重建注册表，避免禁用插件被扫描复活
        await refreshPlugins(registry)
        return jsonOk(event, result)
      },
    },
    {
      method: 'POST',
      path: '/api/plugins/refresh',
      handler: async (event) => jsonOk(event, await refreshPlugins(registry)),
    },
  ]
}

function pluginName(event: Parameters<ApiRoute['handler']>[0]): string {
  return getRouterParam(event, 'name') ?? ''
}
