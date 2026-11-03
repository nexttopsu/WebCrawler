import { describe, expect, it } from 'vitest'

/** 捕获同步异常，便于断言错误码。 */
function catchError(fn: () => unknown): RequestError {
  try {
    fn()
  } catch (error) {
    return error as RequestError
  }
  throw new Error('预期抛出异常，但没有')
}
import {
  RequestError,
  RequestErrorCode,
  assertProxyUsable,
  createProxyAgents,
  formatProxyForLog,
  isSocksProxy,
  parseProxyUrl,
  resolveProxy,
  toNativeProxyConfig,
} from '../../src/request/index.js'

describe('parseProxyUrl', () => {
  it('解析带认证的 HTTP 代理', () => {
    expect(parseProxyUrl('http://user:p%40ss@127.0.0.1:8080')).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'user',
      password: 'p@ss',
    })
  })

  it('解析 SOCKS5 代理并补默认端口', () => {
    expect(parseProxyUrl('socks5://10.0.0.9')).toEqual({ protocol: 'socks5', host: '10.0.0.9', port: 1080 })
  })

  it('省略协议时按 HTTP 处理', () => {
    expect(parseProxyUrl('127.0.0.1:3128')).toMatchObject({ protocol: 'http', port: 3128 })
  })

  it('拒绝非法端口与协议', () => {
    expect(() => parseProxyUrl('http://host:99999')).toThrow(RequestError)
    expect(catchError(() => parseProxyUrl('ftp://host:21')).code).toBe(RequestErrorCode.UNSUPPORTED)
  })
})

describe('代理优先级', () => {
  const task = { protocol: 'http' as const, host: 'task', port: 1 }
  const category = { protocol: 'http' as const, host: 'category', port: 2 }
  const site = { protocol: 'http' as const, host: 'site', port: 3 }
  const system = { protocol: 'http' as const, host: 'system', port: 4 }

  it('任务 > 栏目 > 网站 > 系统 > 直连', () => {
    expect(resolveProxy({ task, category, site, system })?.host).toBe('task')
    expect(resolveProxy({ category, site, system })?.host).toBe('category')
    expect(resolveProxy({ site, system })?.host).toBe('site')
    expect(resolveProxy({ system })?.host).toBe('system')
    expect(resolveProxy({})).toBeNull()
    expect(resolveProxy({ system: null })).toBeNull()
  })
})

describe('代理配置转换与脱敏', () => {
  const proxy = { protocol: 'http' as const, host: '127.0.0.1', port: 8080, username: 'u', password: 'p' }

  it('日志描述不包含账号密码', () => {
    expect(formatProxyForLog(proxy)).toBe('http://127.0.0.1:8080')
    expect(formatProxyForLog(null)).toBe('direct')
  })

  it('HTTP 代理转换为 request-pack 原生配置', () => {
    expect(toNativeProxyConfig(proxy)).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      auth: { username: 'u', password: 'p' },
    })
  })

  it('SOCKS5 走独立 Agent，不能交给原生 proxy 配置', () => {
    const socks = { protocol: 'socks5' as const, host: '127.0.0.1', port: 1080 }
    expect(isSocksProxy(socks)).toBe(true)
    expect(catchError(() => toNativeProxyConfig(socks)).code).toBe(RequestErrorCode.UNSUPPORTED)

    const agents = createProxyAgents(socks)
    expect(agents.httpAgent).toBe(agents.httpsAgent)
    expect(agents.httpAgent.constructor.name).toContain('SocksProxyAgent')
  })

  it('SOCKS4 明确报不支持，而不是静默直连', () => {
    expect(catchError(() => assertProxyUsable({ protocol: 'socks4', host: '127.0.0.1', port: 1080 })).code).toBe(
      RequestErrorCode.UNSUPPORTED,
    )
  })
})
