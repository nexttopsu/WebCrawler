import { setHeader } from 'h3'
import { jsonOk } from '../lib/response.js'
import { parseBooleanFlag, parseIdParam, parseOptionalBody, parseQuery } from '../lib/validation.js'
import { parseBody } from '../lib/validation.js'
import {
  assertHttpUrl,
  createProxy,
  deleteProxy,
  getProxy,
  listProxies,
  proxyCreateSchema,
  proxyEnabledSchema,
  proxyListQuerySchema,
  proxyTestSchema,
  proxyUpdateSchema,
  setProxyEnabled,
  testProxy,
  updateProxy,
} from '../services/proxy-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/**
 * 代理管理。
 *
 * 列表与详情只返回 `hasPassword`，任何情况下都不回传密码（明文或密文）；
 * 密码写入时用 `PROXY_SECRET_KEY` 派生密钥做 AES-256-GCM 加密。
 */
export function proxyRoutes(deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/proxies',
      handler: (event) => jsonOk(event, listProxies(parseQuery(event, proxyListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/proxies',
      handler: async (event) => {
        const input = await parseBody(event, proxyCreateSchema)
        const proxy = createProxy(input)
        setHeader(event, 'location', `/api/proxies/${proxy.id}`)
        return jsonOk(event, proxy, 201)
      },
    },
    {
      method: 'GET',
      path: '/api/proxies/:id',
      handler: (event) => jsonOk(event, getProxy(parseIdParam(event))),
    },
    {
      method: 'PUT',
      path: '/api/proxies/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        return jsonOk(event, updateProxy(id, await parseBody(event, proxyCreateSchema)))
      },
    },
    {
      method: 'PATCH',
      path: '/api/proxies/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        return jsonOk(event, updateProxy(id, await parseBody(event, proxyUpdateSchema)))
      },
    },
    {
      method: 'PATCH',
      path: '/api/proxies/:id/status',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, proxyEnabledSchema)
        return jsonOk(event, setProxyEnabled(id, input.enabled))
      },
    },
    {
      method: 'POST',
      path: '/api/proxies/:id/test',
      handler: async (event) => {
        const id = parseIdParam(event)
        const body = await parseOptionalBody(event, proxyTestSchema)
        const target = assertHttpUrl(body?.url ?? deps.config.proxyTestUrl)
        return jsonOk(event, await testProxy(id, deps.request, target))
      },
    },
    {
      method: 'DELETE',
      path: '/api/proxies/:id',
      handler: (event) => {
        const id = parseIdParam(event)
        const force = parseBooleanFlag((event.url.searchParams.get('force') ?? undefined), 'force')
        return jsonOk(event, deleteProxy(id, { force }))
      },
    },
  ]
}
