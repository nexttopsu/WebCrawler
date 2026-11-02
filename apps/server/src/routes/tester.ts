import type { RequestClient } from '@webcrawler/request'
import { jsonOk } from '../lib/response.js'
import { parseBody } from '../lib/validation.js'
import {
  checkSelector,
  fetchPageSnapshot,
  listTestBodySchema,
  detailTestBodySchema,
  ruleValidateBodySchema,
  selectorCheckBodySchema,
  snapshotBodySchema,
  testAdhocDetail,
  testAdhocList,
  validateRuleInput,
} from '../services/tester-service.js'
import type { ApiRoute } from './types.js'

/** 测试器路由依赖：与站点/规则路由相同的请求运行时。 */
export interface TesterRouteDeps {
  request: RequestClient
  allowPrivateNetwork: boolean
}

/**
 * 可视化规则测试器 API。
 *
 * 全部为 POST：入参是「还没保存的规则片段 + 目标地址」，
 * 由 Service 复用统一请求层与采集核心执行，超时 / 大小限制 / SSRF 在其中继承。
 */
export function testerRoutes(deps: TesterRouteDeps): ApiRoute[] {
  const runtime = { request: deps.request, allowPrivateNetwork: deps.allowPrivateNetwork }

  return [
    {
      method: 'POST',
      path: '/api/tester/snapshot',
      handler: async (event) => {
        const input = await parseBody(event, snapshotBodySchema)
        return jsonOk(event, await fetchPageSnapshot(input, runtime))
      },
    },
    {
      method: 'POST',
      path: '/api/tester/list',
      handler: async (event) => {
        const input = await parseBody(event, listTestBodySchema)
        return jsonOk(event, await testAdhocList(input, runtime))
      },
    },
    {
      method: 'POST',
      path: '/api/tester/detail',
      handler: async (event) => {
        const input = await parseBody(event, detailTestBodySchema)
        return jsonOk(event, await testAdhocDetail(input, runtime))
      },
    },
    {
      method: 'POST',
      path: '/api/tester/selector',
      handler: async (event) => {
        const input = await parseBody(event, selectorCheckBodySchema)
        return jsonOk(event, await checkSelector(input, runtime))
      },
    },
    {
      // 静态路径注册在含参路径之前是全局约定；本路由没有 :id，保持声明顺序即可
      method: 'POST',
      path: '/api/tester/rule/validate',
      handler: async (event) => {
        const input = await parseBody(event, ruleValidateBodySchema)
        return jsonOk(event, validateRuleInput(input.config))
      },
    },
  ]
}
