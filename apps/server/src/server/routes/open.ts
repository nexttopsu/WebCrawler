import { OPEN_API_DOC } from '../../shared/index.js'
import { jsonOk } from '../lib/response.js'
import { parseIdParam, parseQuery } from '../lib/validation.js'
import {
  getOpenArticle,
  listOpenArticles,
  listOpenSitesWithColumns,
  openArticleQuerySchema,
} from '../services/open-api-service.js'
import type { ApiRoute } from './types.js'

/**
 * 开放（只读）接口。
 *
 * 与管理端 `/api/...` 分开挂在 `/api/open` 前缀下：对接方只需要这一组路径，
 * 也不会误打误撞调用到写接口（所有路由都声明为 GET，其它方法统一 405）。
 *
 * 网站接口把栏目一起带回来（`[{ ...site, columns: [...] }]`），因此不再单独提供栏目接口；
 * 网站/栏目是配置类数据不分页，文章会持续增长保留分页。
 *
 * `GET /api/open/docs` 返回与后台「接口文档」页面同源的描述，
 * 方便对接方程序化获取，而不是复制一份可能过期的文档。
 */
export function openRoutes(): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/open/docs',
      handler: (event) => jsonOk(event, OPEN_API_DOC),
    },
    {
      method: 'GET',
      path: '/api/open/sites',
      handler: (event) => jsonOk(event, listOpenSitesWithColumns()),
    },
    {
      method: 'GET',
      path: '/api/open/articles',
      handler: (event) => jsonOk(event, listOpenArticles(parseQuery(event, openArticleQuerySchema))),
    },
    {
      method: 'GET',
      path: '/api/open/articles/:id',
      handler: (event) => jsonOk(event, getOpenArticle(parseIdParam(event))),
    },
  ]
}
