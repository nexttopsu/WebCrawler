import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { closeDatabase, initDatabase } from '../../src/database/index.js'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { createLogger } from '../../src/server/lib/logger.js'

let app: H3

beforeAll(() => {
  initDatabase({ file: ':memory:' })
  app = createApp({
    config: { ...loadConfig({}), logLevel: 'error' },
    logger: createLogger('error'),
  })
})

afterAll(() => {
  closeDatabase()
})

async function requestJson(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await app.request(path, init)
  const body = await response.json()
  return { status: response.status, headers: response.headers, body }
}

describe('GET /api/health', () => {
  it('返回统一结构与数据库状态', async () => {
    const { status, headers, body } = await requestJson('/api/health')

    expect(status).toBe(200)
    expect(headers.get('content-type')).toContain('application/json')
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('ok')
    expect(body.data.database.status).toBe('up')
    expect(body.data.database.driver).toBe('sqlite')
    expect(typeof body.data.database.latencyMs).toBe('number')
    expect(body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('响应头中的请求 ID 与响应体一致', async () => {
    const { headers, body } = await requestJson('/api/health')
    expect(headers.get('x-request-id')).toBe(body.meta.requestId)
  })
})

describe('GET /api/system/info', () => {
  it('返回运行时信息与工作空间包列表', async () => {
    const { status, body } = await requestJson('/api/system/info')

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.name).toBe('WebCrawler')
    expect(body.data.runtime.node).toBe(process.version)
    expect(body.data.database.schemaVersion).toBe(3)
    expect(body.data.database.models).toHaveLength(12)
    expect(body.data.packages.map((item: { name: string }) => item.name)).toEqual([
      'shared',
      'database',
      'request',
      'core',
      'plugin-system',
    ])
    expect(body.data.plugins.registered).toBe(0)
    expect(body.data.verbose).toBeUndefined()
  })

  it('verbose=true 时附带内存与配置信息', async () => {
    const { body } = await requestJson('/api/system/info?verbose=true')

    expect(body.success).toBe(true)
    expect(body.data.verbose.memory.rss).toBeGreaterThan(0)
    expect(body.data.verbose.config.port).toBeGreaterThan(0)
  })

  it('参数校验失败时返回 400 与字段级错误', async () => {
    const { status, body } = await requestJson('/api/system/info?verbose=maybe')

    expect(status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(body.error.details)).toBe(true)
    expect(body.error.details[0].path).toBe('verbose')
  })
})

describe('错误与 CORS', () => {
  it('未知路由返回统一 404 结构', async () => {
    const { status, body } = await requestJson('/api/not-exists')

    expect(status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.meta.requestId).toBeTruthy()
  })

  it('路径存在但方法不支持时返回 405', async () => {
    const { status, headers, body } = await requestJson('/api/health', { method: 'POST' })

    expect(status).toBe(405)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED')
    expect(headers.get('allow')).toBe('GET')
  })

  it('带路径参数的路由同样能识别 405', async () => {
    const { status, headers } = await requestJson('/api/sites/1', { method: 'POST' })

    expect(status).toBe(405)
    expect(headers.get('allow')?.split(', ').sort()).toEqual(['DELETE', 'GET', 'PATCH', 'PUT'])
  })

  it('预检请求返回 CORS 响应头', async () => {
    const response = await app.request('/api/health', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('普通请求也带上 CORS 头', async () => {
    const response = await app.request('/api/health', { headers: { origin: 'http://localhost:5173' } })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
