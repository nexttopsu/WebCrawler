import { z } from 'zod'
import { jsonOk } from '../lib/response.js'
import { parseBody, parseIdParam, parseQuery } from '../lib/validation.js'
import {
  articleListQuerySchema,
  deleteArticle,
  deleteArticles,
  EXPORT_MAX,
  exportArticles,
  getArticle,
  getArticleRaw,
  listArticles,
} from '../services/article-service.js'
import {
  articleCollectDetailSchema,
  collectArticleDetails,
} from '../services/article-collect-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

const exportQuerySchema = articleListQuerySchema.extend({
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(EXPORT_MAX).default(1000),
})

const batchDeleteSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).strict()

/**
 * 文章数据接口。
 *
 * 导出注册在 `/:id` 之前：否则 `/api/articles/export` 会被当成 id=export。
 * 导出返回流式 Response，内存中只保留一批数据，并硬性限制单次条数。
 */
export function articleRoutes(deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/articles',
      handler: (event) => jsonOk(event, listArticles(parseQuery(event, articleListQuerySchema))),
    },
    {
      method: 'GET',
      path: '/api/articles/export',
      handler: (event) => {
        const query = parseQuery(event, exportQuerySchema)
        const exported = exportArticles(query, query.format, query.limit)
        return new Response(exported.stream, {
          status: 200,
          headers: {
            'content-type': exported.contentType,
            'content-disposition': `attachment; filename="${exported.filename}"`,
            'cache-control': 'no-store',
            'x-export-limit': String(query.limit),
          },
        })
      },
    },
    {
      method: 'POST',
      path: '/api/articles/batch-delete',
      handler: async (event) => {
        const input = await parseBody(event, batchDeleteSchema)
        return jsonOk(event, deleteArticles(input.ids))
      },
    },
    {
      method: 'POST',
      path: '/api/articles/collect-detail',
      handler: async (event) => {
        const input = await parseBody(event, articleCollectDetailSchema)
        // 走运行时创建，任务才会立即入队；直接调服务层只会写库
        return jsonOk(
          event,
          collectArticleDetails(input, (taskInput) =>
            deps.runtime.createTask(taskInput, { trigger: 'manual' }),
          ),
        )
      },
    },
    {
      method: 'GET',
      path: '/api/articles/:id',
      handler: (event) => jsonOk(event, getArticle(parseIdParam(event))),
    },
    {
      method: 'GET',
      path: '/api/articles/:id/raw',
      handler: (event) => jsonOk(event, getArticleRaw(parseIdParam(event))),
    },
    {
      method: 'DELETE',
      path: '/api/articles/:id',
      handler: (event) => jsonOk(event, deleteArticle(parseIdParam(event))),
    },
  ]
}
