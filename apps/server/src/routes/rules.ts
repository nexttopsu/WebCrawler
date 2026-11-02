import { getQuery, setHeader } from 'h3'
import type { RequestClient } from '@webcrawler/request'
import { z } from 'zod'
import { jsonOk } from '../lib/response.js'
import { parseBody, parseIdParam, parseOptionalBody, parseQuery } from '../lib/validation.js'
import {
  createRule,
  deleteRule,
  getRule,
  getRuleVersion,
  listRules,
  listRuleVersions,
  resolveEffectiveRule,
  resolveRuleSchema,
  ruleCreateSchema,
  ruleListQuerySchema,
  rulePatchSchema,
  ruleReplaceSchema,
  ruleStatusSchema,
  setRuleStatus,
  updateRule,
} from '../services/rule-service.js'
import { testRuleListing } from '../services/rule-test-service.js'
import type { ApiRoute } from './types.js'

export interface RuleRouteDeps {
  request: RequestClient
  allowPrivateNetwork: boolean
}

/** 规则试抓的可选请求体：允许临时换一个列表地址，不写入规则。 */
const ruleTestBodySchema = z.object({ url: z.string().trim().max(2048).optional() }).strict()

/** 采集规则 API：含版本查询、生效规则计算与试抓。 */
export function ruleRoutes(deps: RuleRouteDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/rules',
      handler: (event) => jsonOk(event, listRules(parseQuery(event, ruleListQuerySchema))),
    },
    {
      method: 'POST',
      path: '/api/rules',
      handler: async (event) => {
        const input = await parseBody(event, ruleCreateSchema)
        const created = createRule(input)
        setHeader(event, 'location', `/api/rules/${created.id}`)
        return jsonOk(event, created, 201)
      },
    },
    {
      // 静态路径必须在 `/:id` 之前注册，避免被当成 id
      method: 'POST',
      path: '/api/rules/resolve',
      handler: async (event) => {
        const input = await parseBody(event, resolveRuleSchema)
        return jsonOk(event, resolveEffectiveRule(input))
      },
    },
    {
      method: 'GET',
      path: '/api/rules/:id',
      handler: (event) => jsonOk(event, getRule(parseIdParam(event))),
    },
    {
      method: 'PUT',
      path: '/api/rules/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, ruleReplaceSchema)
        return jsonOk(event, updateRule(id, input, true))
      },
    },
    {
      method: 'PATCH',
      path: '/api/rules/:id',
      handler: async (event) => {
        const id = parseIdParam(event)
        const input = await parseBody(event, rulePatchSchema)
        return jsonOk(event, updateRule(id, input))
      },
    },
    {
      method: 'DELETE',
      path: '/api/rules/:id',
      handler: (event) => {
        const id = parseIdParam(event)
        const force = getQuery(event).force === 'true' || getQuery(event).force === '1'
        return jsonOk(event, { ...deleteRule(id, { force }), deleted: true })
      },
    },
    {
      method: 'PATCH',
      path: '/api/rules/:id/status',
      handler: async (event) => {
        const id = parseIdParam(event)
        const { status } = await parseBody(event, ruleStatusSchema)
        return jsonOk(event, setRuleStatus(id, status))
      },
    },
    {
      method: 'GET',
      path: '/api/rules/:id/versions',
      handler: (event) => jsonOk(event, { items: listRuleVersions(parseIdParam(event)) }),
    },
    {
      method: 'GET',
      path: '/api/rules/:id/versions/:version',
      handler: (event) => {
        const id = parseIdParam(event)
        const version = parseIdParam(event, 'version')
        return jsonOk(event, getRuleVersion(id, version))
      },
    },
    {
      method: 'POST',
      path: '/api/rules/:id/test',
      handler: async (event) => {
        const id = parseIdParam(event)
        const body = await parseOptionalBody(event, ruleTestBodySchema)
        return jsonOk(
          event,
          await testRuleListing(
            id,
            { request: deps.request, allowPrivateNetwork: deps.allowPrivateNetwork },
            body?.url,
          ),
        )
      },
    },
  ]
}
