/**
 * 静态资源托管测试（GET /resources/**）。
 *
 * 用临时目录充当资源根，验证：正常访问、子目录、404 统一结构与目录穿越防护。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { H3 } from 'h3'
import { closeDatabase, initDatabase } from '../../src/database/index.js'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { createLogger } from '../../src/server/lib/logger.js'

/** 一张 1x1 PNG 的原始字节。 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

let app: H3
let resourcesDir: string

beforeAll(() => {
  resourcesDir = mkdtempSync(join(tmpdir(), 'webcrawler-resources-'))
  writeFileSync(join(resourcesDir, 'cover.png'), PNG_BYTES)
  mkdirSync(join(resourcesDir, 'covers', 'site-a'), { recursive: true })
  writeFileSync(join(resourcesDir, 'covers', 'site-a', 'abc.jpg'), PNG_BYTES)

  process.env.RESOURCES_DIR = resourcesDir
  initDatabase({ file: ':memory:' })
  app = createApp({
    config: { ...loadConfig({}), logLevel: 'error' },
    logger: createLogger('error'),
  })
})

afterAll(() => {
  closeDatabase()
  delete process.env.RESOURCES_DIR
  rmSync(resourcesDir, { recursive: true, force: true })
})

describe('GET /resources/**', () => {
  it('根目录文件按正确 Content-Type 返回', async () => {
    const response = await app.request('/resources/cover.png')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('子目录文件可访问（缩略图存储形态）', async () => {
    const response = await app.request('/resources/covers/site-a/abc.jpg')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
  })

  it('不存在的资源返回统一 404 结构', async () => {
    const response = await app.request('/resources/missing.png')
    const body = (await response.json()) as { success: boolean; error: { message: string } }

    expect(response.status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.error.message).toBe('静态资源不存在')
  })

  it('目录穿越（%2e%2e）被拒绝', async () => {
    const response = await app.request('/resources/%2e%2e/%2e%2e/package.json')

    expect(response.status).toBe(404)
  })

  it('HEAD 请求只返回头信息', async () => {
    const response = await app.request('/resources/cover.png', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.byteLength))
    expect(await response.text()).toBe('')
  })
})
