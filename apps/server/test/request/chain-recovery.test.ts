import { describe, expect, it } from 'vitest'
import {
  encodeCertificatePem,
  isIncompleteChainError,
  parseAiaIssuerUrls,
} from '../../src/request/chain-recovery.js'

/** 构造一段包含 AIA 扩展最小结构的合成 DER。 */
function buildDerWithAia(uri: string): Buffer {
  const urlBytes = Buffer.from(uri, 'latin1')
  const caIssuersOid = Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02])
  // GeneralName [6] IMPLICIT IA5String：长度 > 127 时使用 DER 长格式
  const uriField =
    urlBytes.length < 128
      ? Buffer.concat([Buffer.from([0x86, urlBytes.length]), urlBytes])
      : Buffer.concat([
          Buffer.from([0x86, 0x81, urlBytes.length]),
          urlBytes,
        ])
  const accessDescription = Buffer.concat([caIssuersOid, uriField])
  const aiaOid = Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01])
  // extnValue: OCTET STRING { SEQUENCE { AccessDescription } }
  const sequence = Buffer.concat([Buffer.from([0x30, accessDescription.length]), accessDescription])
  const octetString = Buffer.concat([Buffer.from([0x04, sequence.length]), sequence])
  return Buffer.concat([aiaOid, octetString])
}

describe('parseAiaIssuerUrls', () => {
  it('提取 caIssuers URI', () => {
    const der = buildDerWithAia('http://certum.pl/repo.crt')
    expect(parseAiaIssuerUrls(der)).toEqual(['http://certum.pl/repo.crt'])
  })

  it('长 URL 使用 DER 长格式，仍可解析', () => {
    const longPath = `http://example.com/${'a'.repeat(150)}.crt`
    expect(parseAiaIssuerUrls(buildDerWithAia(longPath))).toEqual([longPath])
  })

  it('同一证书里多个地址去重', () => {
    const url = 'http://example.com/issuer.crt'
    const der = Buffer.concat([buildDerWithAia(url), buildDerWithAia(url)])
    expect(parseAiaIssuerUrls(der)).toEqual([url])
  })

  it('非 http(s) 的 URI 与无 AIA 的 DER 返回空', () => {
    expect(parseAiaIssuerUrls(buildDerWithAia('ldap://example.com/ca'))).toEqual([])
    expect(parseAiaIssuerUrls(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]))).toEqual([])
  })
})

describe('isIncompleteChainError', () => {
  it('识别直接命中与 cause 链深处的链错误码', () => {
    expect(
      isIncompleteChainError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
    ).toBe(true)
    expect(
      isIncompleteChainError({
        message: 'RequestError',
        cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' },
      }),
    ).toBe(true)
    expect(
      isIncompleteChainError({
        cause: { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } },
      }),
    ).toBe(true)
  })

  it('其他错误码与普通值返回 false', () => {
    expect(isIncompleteChainError({ code: 'ECONNREFUSED' })).toBe(false)
    expect(isIncompleteChainError(new Error('boom'))).toBe(false)
    expect(isIncompleteChainError(null)).toBe(false)
    expect(isIncompleteChainError('string error')).toBe(false)
  })
})

describe('encodeCertificatePem', () => {
  it('PEM 输入原样返回，缺失 END 视为不合法', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n'
    expect(encodeCertificatePem(Buffer.from(pem, 'latin1'))).toBe(pem)
    expect(encodeCertificatePem(Buffer.from('-----BEGIN CERTIFICATE-----\nabc'))).toBeNull()
  })

  it('DER 输入转成换行折行的 PEM', () => {
    const der = Buffer.alloc(200, 0x30)
    der[0] = 0x30
    const pem = encodeCertificatePem(der) ?? ''
    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true)
    expect(pem.endsWith('-----END CERTIFICATE-----\n')).toBe(true)
    expect(pem.split('\n')[1]?.length).toBeLessThanOrEqual(64)
  })

  it('空内容与非证书输入返回 null', () => {
    expect(encodeCertificatePem(Buffer.alloc(0))).toBeNull()
    expect(encodeCertificatePem(Buffer.from('not a cert'))).toBeNull()
  })
})
