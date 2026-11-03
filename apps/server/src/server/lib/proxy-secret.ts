/**
 * 代理密码密钥的进程级持有者。
 *
 * 配置在启动时由 `createApp` 注入一次；业务代码通过这里加解密，
 * 不需要层层传递密钥，也不会把密钥写进任何 DTO 或日志。
 */
import { ConfigurationError } from '../errors.js'
import { decryptSecret, encryptSecret, isEncryptedSecret } from './crypto.js'

let secretKey: string | null = null

/** 设置密钥；null 表示未配置（读取加密密码会明确报错）。 */
export function setProxySecretKey(value: string | null | undefined): void {
  const trimmed = value?.trim()
  secretKey = trimmed ? trimmed : null
}

export function getProxySecretKey(): string | null {
  return secretKey
}

export function hasProxySecret(): boolean {
  return secretKey !== null
}

/** 加密代理密码；未配置密钥时返回 503，绝不退化为明文。 */
export function encryptProxyPassword(plaintext: string): string {
  if (!secretKey) {
    throw new ConfigurationError(
      '未配置 PROXY_SECRET_KEY，无法安全保存代理密码。请在环境变量中设置至少 16 个字符的密钥后重启服务。',
    )
  }
  return encryptSecret(plaintext, secretKey)
}

/**
 * 解密代理密码。
 *
 * 历史明文记录（无 `enc:v1:` 前缀）原样返回，保证旧数据仍可用；
 * 需要在代理管理页重新保存一次完成加密迁移。
 */
export function decryptProxyPassword(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (!isEncryptedSecret(stored)) return stored
  if (!secretKey) {
    throw new ConfigurationError(
      '代理密码已加密，但当前进程未配置 PROXY_SECRET_KEY，无法解密。请恢复原来的密钥后重试。',
    )
  }
  try {
    return decryptSecret(stored, secretKey)
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error ? error.message : '代理密码解密失败',
    )
  }
}
