/**
 * `createScopedRequest` 验收：插件拿到的请求器必须带上本次运行的代理。
 *
 * 这里用假客户端记录每次调用的参数——真实网络行为由 http-client.test.ts 覆盖，
 * 本文件只保证「代理有没有被正确填进去」。
 */
import { describe, expect, it } from 'vitest'
import { createScopedRequest } from '../../src/request/index.js'
import type { HttpRequestOptions, HttpResponse, RequestClient } from '../../src/request/index.js'
import type { ProxySettings } from '../../src/shared/index.js'

const PROXY: ProxySettings = { protocol: 'http', host: '127.0.0.1', port: 7890 }

/** 记录调用参数的假客户端：只实现被 scoped 视图用到的五个方法。 */
function createFakeClient() {
  const calls: Array<{ method: string; options: Record<string, unknown> }> = []
  const response = { ok: true, status: 200, text: '' } as HttpResponse

  const client = {
    request: async (options: HttpRequestOptions) => {
      calls.push({ method: 'request', options: options as unknown as Record<string, unknown> })
      return response
    },
    get: async (url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}) => {
      calls.push({ method: 'get', options: { url, ...options } })
      return response
    },
    post: async (url: string, body?: unknown, options: Omit<HttpRequestOptions, 'url' | 'method' | 'body'> = {}) => {
      calls.push({ method: 'post', options: { url, body, ...options } })
      return response
    },
    getText: async (url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}) => {
      calls.push({ method: 'getText', options: { url, ...options } })
      return ''
    },
    getJson: async <T>(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}) => {
      calls.push({ method: 'getJson', options: { url, ...options } })
      return {} as T
    },
  }

  return { client: client as unknown as RequestClient, calls }
}

describe('createScopedRequest', () => {
  it('get 未指定代理时自动带上默认代理', async () => {
    const { client, calls } = createFakeClient()
    await createScopedRequest(client, PROXY).get('https://example.com/a')
    expect(calls[0]?.options.proxy).toEqual(PROXY)
  })

  it('get 显式传 null 时保持直连（不被默认代理覆盖）', async () => {
    const { client, calls } = createFakeClient()
    await createScopedRequest(client, PROXY).get('https://example.com/a', { proxy: null })
    expect(calls[0]?.options.proxy).toBeNull()
  })

  it('get 显式传代理时以调用方为准', async () => {
    const other: ProxySettings = { protocol: 'https', host: '10.0.0.1', port: 8443 }
    const { client, calls } = createFakeClient()
    await createScopedRequest(client, PROXY).get('https://example.com/a', { proxy: other })
    expect(calls[0]?.options.proxy).toEqual(other)
  })

  it('request / post / getText / getJson 都带默认代理', async () => {
    const { client, calls } = createFakeClient()
    const scoped = createScopedRequest(client, PROXY)
    await scoped.request({ url: 'https://example.com/x' })
    await scoped.post('https://example.com/y', { a: 1 })
    await scoped.getText('https://example.com/z')
    await scoped.getJson('https://example.com/j')
    expect(calls.map((call) => call.options.proxy)).toEqual([PROXY, PROXY, PROXY, PROXY])
  })

  it('默认代理为 null 时不额外注入代理配置', async () => {
    const { client, calls } = createFakeClient()
    await createScopedRequest(client, null).get('https://example.com/a')
    expect(calls[0]?.options.proxy).toBeNull()
  })

  it('不影响调用方传入的其他参数', async () => {
    const { client, calls } = createFakeClient()
    await createScopedRequest(client, PROXY).get('https://example.com/a', {
      headers: { referer: 'https://example.com' },
      timeoutMs: 1234,
    })
    expect(calls[0]?.options).toMatchObject({
      headers: { referer: 'https://example.com' },
      timeoutMs: 1234,
      proxy: PROXY,
    })
  })
})
