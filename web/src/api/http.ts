/**
 * 兼容旧调用点的请求适配器。
 *
 * 第四阶段的测试器模块使用 `apiRequest(path, { method, body })` 这种写法，
 * 这里把它转成 Axios 配置，避免为改封装而重写已验收的测试器代码。
 */
import { ApiClientError, normalizeError, request } from './client'

export { ApiClientError }

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') {
    if (!body.trim()) return undefined
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  return body
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    return await request<T>({
      url: path,
      method: (options.method ?? 'GET').toUpperCase(),
      data: parseBody(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers as Record<string, string> } : {}),
    })
  } catch (error) {
    throw normalizeError(error)
  }
}
