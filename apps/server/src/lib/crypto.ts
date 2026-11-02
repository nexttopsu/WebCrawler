/**
 * 代理密码的对称加密。
 *
 * 算法：AES-256-GCM。密钥由 `PROXY_SECRET_KEY` 通过 scrypt 派生，
 * 盐是固定字符串（不是每条记录随机）——因为每条记录已经带了随机 IV，
 * 固定盐只用于把任意长度的配置值稳定派生为 32 字节密钥。
 *
 * 存储格式：`enc:v1:<iv base64>:<tag base64>:<密文 base64>`
 * - 带前缀便于识别历史明文记录（旧库中的密码没有前缀，读取时按明文处理）；
 * - GCM 自带完整性校验，密文被篡改会解密失败，而不是返回垃圾数据。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'
const KEY_SALT = 'webcrawler:proxy:v1'
const KEY_LENGTH = 32
const IV_LENGTH = 12

/** 密钥未配置或格式不可用。 */
export class ProxySecretError extends Error {
  override readonly name = 'ProxySecretError'

  constructor(message: string) {
    super(message)
  }
}

function deriveKey(secret: string): Buffer {
  const value = secret.trim()
  if (value.length < 16) {
    throw new ProxySecretError('PROXY_SECRET_KEY 至少需要 16 个字符，用于派生代理密码加密密钥')
  }
  return scryptSync(value, KEY_SALT, KEY_LENGTH)
}

/** 加密密码。空值返回 null（表示没有密码）。 */
export function encryptSecret(plaintext: string, secret: string): string {
  const value = plaintext
  if (!value) throw new ProxySecretError('待加密内容不能为空')
  const key = deriveKey(secret)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

/**
 * 解密密码。
 *
 * 没有 `enc:v1:` 前缀的值按历史明文处理并原样返回：
 * 第三阶段之前创建的代理记录没有加密，直接读会失败；
 * 服务层在读取时会给出一次告警，提示重新保存以完成加密。
 */
export function decryptSecret(stored: string, secret: string | null): string {
  if (!stored.startsWith(PREFIX)) return stored
  if (!secret) {
    throw new ProxySecretError('代理密码已加密，但未配置 PROXY_SECRET_KEY，无法解密')
  }

  const payload = stored.slice(PREFIX.length)
  const parts = payload.split(':')
  if (parts.length !== 3) throw new ProxySecretError('代理密码密文格式不正确')

  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const key = deriveKey(secret)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'))
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new ProxySecretError('代理密码解密失败：PROXY_SECRET_KEY 可能已更换')
  }
}

/** 是否已经是密文。 */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}
