import { getQuery, getRouterParam, HTTPError, readBody, type H3Event } from 'h3'
import { z } from 'zod'
import { BadRequestError, ValidationError } from '../errors.js'

interface ValidationIssue {
  path: string
  message: string
  code: string
}

/** 把 zod 的错误转成对外的字段级列表，避免把内部结构直接暴露出去。 */
export function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }))
}

/**
 * 用 zod 校验查询参数。
 *
 * 校验失败时统一抛出 `ValidationError`，由错误中间件转成 400 + 字段级 details。
 */
export function parseQuery<S extends z.ZodType>(event: H3Event, schema: S): z.output<S> {
  const result = schema.safeParse(getQuery(event))
  if (!result.success) {
    throw new ValidationError('查询参数校验失败', toIssues(result.error))
  }
  return result.data
}

/**
 * 用 zod 校验请求体。
 *
 * 空请求体与非法 JSON 都转成 400：前者由 Schema 报「必填」，
 * 后者给出明确的「不是合法 JSON」，不把 h3 的解析异常泄漏出去。
 */
export async function parseBody<S extends z.ZodType>(event: H3Event, schema: S): Promise<z.output<S>> {
  let raw: unknown
  try {
    raw = await readBody(event)
  } catch (error) {
    if (HTTPError.isError(error)) {
      throw new BadRequestError('请求体不是合法的 JSON')
    }
    throw error
  }

  if (raw === undefined || raw === null || raw === '') {
    throw new ValidationError('请求体不能为空', [{ path: '', message: '请求体不能为空', code: 'invalid_type' }])
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new ValidationError('请求参数校验失败', toIssues(result.error))
  }
  return result.data
}

/**
 * 校验可选请求体：空体返回 undefined，其余按 Schema 校验。
 *
 * 用于「POST 且参数都可选」的接口（例如规则试抓），
 * 避免要求调用方必须发送 `{}`。
 */
export async function parseOptionalBody<S extends z.ZodType>(
  event: H3Event,
  schema: S,
): Promise<z.output<S> | undefined> {
  let raw: unknown
  try {
    raw = await readBody(event)
  } catch (error) {
    if (HTTPError.isError(error)) {
      throw new BadRequestError('请求体不是合法的 JSON')
    }
    throw error
  }

  if (raw === undefined || raw === null || raw === '') return undefined

  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new ValidationError('请求参数校验失败', toIssues(result.error))
  }
  return result.data
}

/**
 * 解析路径中的 `:id`。
 *
 * 只接受正整数：`/api/sites/abc` 与 `/api/sites/0` 都返回 400，
 * 与「资源不存在」区分开，便于前端定位问题。
 */
export function parseIdParam(event: H3Event, name = 'id'): number {
  const raw = getRouterParam(event, name)
  const value = Number(raw)
  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`路径参数 ${name} 必须是正整数`, [
      { path: name, message: '必须是正整数', code: 'invalid_type' },
    ])
  }
  return value
}

/** 解析 `?force=true` 这类布尔查询参数。 */
export function parseBooleanFlag(raw: unknown, name: string): boolean {
  if (raw === undefined || raw === null || raw === '') return false
  if (raw === true || raw === 'true' || raw === '1') return true
  if (raw === false || raw === 'false' || raw === '0') return false
  throw new ValidationError(`参数 ${name} 只能是 true 或 false`, [
    { path: name, message: '只能是 true 或 false', code: 'invalid_value' },
  ])
}
