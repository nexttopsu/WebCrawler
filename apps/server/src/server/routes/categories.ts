import { setHeader } from 'h3'
import type { RequestClient } from '../../request/index.js'
import type { PluginRegistry } from '../../plugin-system/index.js'
import { jsonOk } from '../lib/response.js'
import { parseBody, parseIdParam, parseQuery } from '../lib/validation.js'
import {
  categoryCreateSchema,
  categoryListQuerySchema,
  categoryPatchSchema,
  categoryReplaceSchema,
  categoryStatusSchema,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  setCategoryEnabled,
  updateCategory,
} from '../services/category-service.js'
import { testCategoryListing } from '../services/rule-test-service.js'
import type { ApiRoute } from './types.js'

export interface CategoryRouteDeps {
  request: RequestClient
  allowPrivateNetwork: boolean
  /** 插件注册表：规则配置 parserPlugins 时，试抓也执行真实插件链 */
  pluginRegistry?: PluginRegistry
}

/** 栏目管理 API。站点归属不可变更，其他字段支持 PUT 整体替换与 PATCH 局部更新。 */
export function categoryRoutes(deps: CategoryRouteDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/categories',
      handler: (event) => jsonOk(event, listCategories(parseQuery(event, categoryListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/categories',
      handler: async (event) => {
        const input = await parseBody(event, categoryCreateSchema)
        const created = createCategory(input)
        setHeader(event, 'location', `/api/categories/${created.id}`)
        return jsonOk(event, created, 201)
      },
    },
    {
      method: 'GET',
      path: '/api/categories/:id',
      handler: (event) => jsonOk(event, getCategory(parseIdParam(event))),
    },
    {
      method: 'PUT',
      path: '/api/categories/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, categoryReplaceSchema)
        return jsonOk(event, updateCategory(id, input, true))
      },
    },
    {
      method: 'PATCH',
      path: '/api/categories/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, categoryPatchSchema)
        return jsonOk(event, updateCategory(id, input))
      },
    },
    {
      method: 'DELETE',
      path: '/api/categories/:id',
      handler: (event) => jsonOk(event, { ...deleteCategory(parseIdParam(event)), deleted: true }),
    },
    {
      method: 'PATCH',
      path: '/api/categories/:id/status',
      handler: async (event) => {
        const id = parseIdParam(event)
        const { enabled } = await parseBody(event, categoryStatusSchema)
        return jsonOk(event, setCategoryEnabled(id, enabled))
      },
    },
    {
      method: 'POST',
      path: '/api/categories/:id/test',
      handler: async (event) => {
        const id = parseIdParam(event)
        return jsonOk(
          event,
          await testCategoryListing(id, {
            request: deps.request,
            allowPrivateNetwork: deps.allowPrivateNetwork,
            ...(deps.pluginRegistry ? { pluginRegistry: deps.pluginRegistry } : {}),
          }),
        )
      },
    },
  ]
}
