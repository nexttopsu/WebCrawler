import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3 } from 'h3'
import { call, json, startTestApp, stopTestApp } from './helpers/app.js'
import { ProxySecretError } from '../src/lib/crypto.js'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../src/lib/crypto.js'

const KEY = 'unit-test-secret-key-please-change'

describe('代理密码加密', () => {
  it('加密后不再是明文，且可以解密回原值', () => {
    const encrypted = encryptSecret('p@ssw0rd', KEY)
    expect(encrypted).not.toContain('p@ssw0rd')
    expect(isEncryptedSecret(encrypted)).toBe(true)
    expect(decryptSecret(encrypted, KEY)).toBe('p@ssw0rd')
  })

  it('每次加密的 IV 不同，密文不同', () => {
    const first = encryptSecret('same', KEY)
    const second = encryptSecret('same', KEY)
    expect(first).not.toBe(second)
    expect(decryptSecret(first, KEY)).toBe('same')
  })

  it('密文被篡改时解密失败，而不是返回垃圾数据', () => {
    const encrypted = encryptSecret('secret', KEY)
    const parts = encrypted.split(':')
    const data = Buffer.from(parts[4]!, 'base64')
    data[0] = data[0]! ^ 0xff
    parts[4] = data.toString('base64')
    expect(() => decryptSecret(parts.join(':'), KEY)).toThrow(ProxySecretError)
  })

  it('更换密钥后解密失败', () => {
    const encrypted = encryptSecret('secret', KEY)
    expect(() => decryptSecret(encrypted, 'another-secret-key-123456')).toThrow('可能已更换')
  })

  it('历史明文记录按明文返回，便于旧数据继续使用', () => {
    expect(decryptSecret('legacy-plain', null)).toBe('legacy-plain')
  })

  it('密钥过短时拒绝加密', () => {
    expect(() => encryptSecret('x', 'short')).toThrow(ProxySecretError)
  })
})

describe('未配置 PROXY_SECRET_KEY 时的行为', () => {
  let app: H3

  beforeAll(() => {
    app = startTestApp({ proxySecretKey: null })
  })

  afterAll(() => stopTestApp())

  it('不带密码的代理可以创建（不依赖密钥）', async () => {
    const response = await call(
      app,
      '/api/proxies',
      json({ name: '无密码代理', type: 'http', host: '10.0.0.1', port: 8080 }),
    )
    expect(response.status).toBe(201)
    expect(response.body.data.hasPassword).toBe(false)
  })

  it('带密码的代理明确返回 503，而不是退化为明文存储', async () => {
    const response = await call(
      app,
      '/api/proxies',
      json({ name: '有密码代理', type: 'http', host: '10.0.0.2', port: 8080, password: 'secret' }),
    )
    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('CONFIGURATION_ERROR')
    expect(response.body.error.message).toContain('PROXY_SECRET_KEY')
  })
})
