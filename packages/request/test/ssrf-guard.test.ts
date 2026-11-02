import { describe, expect, it } from 'vitest'
import {
  SsrfBlockedError,
  assertUrlAllowed,
  createGuardedLookup,
  isBlockedHostname,
  isBlockedIp,
} from '../src/index.js'

describe('SSRF：IP 段判定', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.10.20.30', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['203.0.114.1', false],
    ['not-an-ip', true],
  ])('IPv4 %s 是否禁止：%s', (ip, expected) => {
    expect(isBlockedIp(ip)).toBe(expected)
  })

  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['fc00::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['2001:4860:4860::8888', false],
  ])('IPv6 %s 是否禁止：%s', (ip, expected) => {
    expect(isBlockedIp(ip)).toBe(expected)
  })
})

describe('SSRF：主机名与 URL 校验', () => {
  it('识别 localhost 与云元数据域名', () => {
    expect(isBlockedHostname('localhost')).toBe(true)
    expect(isBlockedHostname('app.localhost')).toBe(true)
    expect(isBlockedHostname('metadata.google.internal')).toBe(true)
    expect(isBlockedHostname('example.com')).toBe(false)
  })

  it('默认拒绝回环地址', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:8080/a')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(assertUrlAllowed('http://localhost/a')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('默认拒绝云元数据地址', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
  })

  it('拒绝非 http(s) 协议', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
    })
  })

  it('显式放行内网时允许本地测试站点', async () => {
    const url = await assertUrlAllowed('http://127.0.0.1:8080/a', { allowPrivateNetwork: true })
    expect(url.port).toBe('8080')
  })

  it('allowedHosts 可精确放行单个主机', async () => {
    await expect(
      assertUrlAllowed('http://127.0.0.1:8080/a', { allowedHosts: ['127.0.0.1'] }),
    ).resolves.toBeInstanceOf(URL)
    await expect(assertUrlAllowed('http://127.0.0.2:8080/a', { allowedHosts: ['127.0.0.1'] })).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
  })
})

describe('SSRF：连接时 DNS 校验', () => {
  it('解析到回环地址时拒绝连接', async () => {
    const lookup = createGuardedLookup()
    const error = await new Promise<Error | null>((resolve) => {
      lookup('localhost', {}, (err) => resolve(err))
    })
    expect(error).toBeInstanceOf(SsrfBlockedError)
  })

  it('公网地址正常解析', async () => {
    const lookup = createGuardedLookup()
    const result = await new Promise<{ address: string } | Error>((resolve) => {
      lookup('8.8.8.8', {}, (err, address) => {
        if (err) resolve(err)
        else resolve({ address: String(address) })
      })
    })
    expect(result).toEqual({ address: '8.8.8.8' })
  })
})
