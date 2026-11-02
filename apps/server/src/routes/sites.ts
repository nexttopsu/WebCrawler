import { getQuery, setHeader } from 'h3'
import type { RequestClient } from '@webcrawler/request'
import { jsonOk } from '../lib/response.js'
import { parseBooleanFlag, parseBody, parseIdParam, parseQuery } from '../lib/validation.js'
import { categoryListQuerySchema } from '../services/category-service.js'
import { listCategories } from '../services/category-service.js'
import {
  createSite,
  deleteSite,
  getSite,
  listSites,
  setSiteStatus,
  siteCreateSchema,
  siteListQuerySchema,
  sitePatchSchema,
  siteReplaceSchema,
  siteStatusSchema,
  testSiteConnection,
  updateSite,
} from '../services/site-service.js'
import type { ApiRoute } from './types.js'

/** 网站管理路由依赖：连接测试需要统一请求客户端。 */
export interface SiteRouteDeps {
  request: RequestClient
}

/**
 * 网站管理 API。
 *
 * 路由只做三件事：解析 HTTP 输入、调用 Service、包装统一响应；
 * 业务规则（唯一性、关联校验、删除约束）全部在 Service 内。
 */
export function siteRoutes(deps: SiteRouteDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/sites',
      handler: (event) => jsonOk(event, listSites(parseQuery(event, siteListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/sites',
      handler: async (event) => {
        const input = await parseBody(event, siteCreateSchema)
        const created = createSite(input)
        setHeader(event, 'location', `/api/sites/${created.id}`)
        return jsonOk(event, created, 201)
      },
    },
    {
      method: 'GET',
      path: '/api/sites/:id',
      handler: (event) => jsonOk(event, getSite(parseIdParam(event))),
    },
    {
      method: 'PUT',
      path: '/api/sites/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, siteReplaceSchema)
        return jsonOk(event, updateSite(id, input, true))
      },
    },
    {
      method: 'PATCH',
      path: '/api/sites/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, sitePatchSchema)
        return jsonOk(event, updateSite(id, input))
      },
    },
    {
      method: 'DELETE',
      path: '/api/sites/:id',
      handler: (event) => {
        const id = parseIdParam(event)
        const force = parseBooleanFlag(getQuery(event).force, 'force')
        return jsonOk(event, { ...deleteSite(id, { force }), deleted: true })
      },
    },
    {
      method: 'PATCH',
      path: '/api/sites/:id/status',
      handler: async (event) => {
        const id = parseIdParam(event)
        const { status } = await parseBody(event, siteStatusSchema)
        return jsonOk(event, setSiteStatus(id, status))
      },
    },
    {
      method: 'POST',
      path: '/api/sites/:id/test',
      handler: async (event) => {
        const id = parseIdParam(event)
        return jsonOk(event, await testSiteConnection(id, { request: deps.request }))
      },
    },
    {
      method: 'GET',
      path: '/api/sites/:id/categories',
      handler: (event) => {
        const siteId = parseIdParam(event)
        // 站点下的栏目列表必须限定在当前站点：路径参数优先于查询参数
        const query = parseQuery(event, categoryListQuerySchema)
        return jsonOk(event, listCategories({ ...query, siteId }))
      },
    },
  ]
}
