/**
 * 绑定代理的请求视图。
 *
 * 插件拿到的 `ctx.request` 必须是「本次运行」的请求器：栏目配了代理、测试器里选了代理，
 * 插件内部发的请求也要走同一个代理，否则插件抓取会绕过代理直连（目标站点看到的是本机 IP）。
 *
 * 这里不新建连接池、不复制客户端，只把默认 `proxy` 填进每次调用：
 * 调用方显式传 `proxy`（包括 `null` 表示本次直连）时以调用方为准。
 */
import type { ProxySettings } from '../shared/index.js'
import type { RequestClient } from './http-client.js'
import type { HttpRequestOptions } from './request-types.js'

/** 除 `url` / `method` 之外的请求参数（`get` / `post` 便捷方法用）。 */
type ScopedOptions = Omit<HttpRequestOptions, 'url' | 'method' | 'body'>

/** 插件可用的请求器：只暴露请求方法，不暴露 `close()` 等生命周期操作。 */
export type ScopedRequestClient = Pick<
  RequestClient,
  'request' | 'get' | 'post' | 'getText' | 'getJson'
>

/** 未显式指定代理时补上默认代理；显式 `null` 表示「这一次直连」，保持不动。 */
function withDefaultProxy(options: ScopedOptions, proxy: ProxySettings | null): ScopedOptions {
  return options.proxy === undefined ? { ...options, proxy } : options
}

/**
 * 创建带默认代理的请求视图。
 *
 * @param base 平台共享的请求客户端（连接池、SSRF 策略、证书补链都在它上面）
 * @param proxy 本次运行的代理；`null` 表示直连
 */
export function createScopedRequest(
  base: RequestClient,
  proxy: ProxySettings | null,
): ScopedRequestClient {
  return {
    request: (options) =>
      base.request(options.proxy === undefined ? { ...options, proxy } : options),
    get: (url, options = {}) => base.get(url, withDefaultProxy(options, proxy)),
    post: (url, body, options = {}) => base.post(url, body, withDefaultProxy(options, proxy)),
    getText: (url, options = {}) => base.getText(url, withDefaultProxy(options, proxy)),
    getJson: <T>(url: string, options: ScopedOptions = {}) =>
      base.getJson<T>(url, withDefaultProxy(options, proxy)),
  }
}
