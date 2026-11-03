import { describe, expect, it } from 'vitest'
import { ErrorCode, isApiSuccess, type ApiResponse } from '../../src/shared/index.js'

describe('API 返回结构', () => {
  it('成功响应通过类型守卫', () => {
    const response: ApiResponse<{ value: number }> = {
      success: true,
      data: { value: 1 },
      meta: { requestId: 'req-1', timestamp: '2026-01-01T00:00:00.000Z' },
    }

    expect(isApiSuccess(response)).toBe(true)
    if (isApiSuccess(response)) {
      expect(response.data.value).toBe(1)
    }
  })

  it('失败响应不被判定为成功', () => {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: ErrorCode.NOT_FOUND, message: '不存在' },
      meta: { requestId: 'req-2', timestamp: '2026-01-01T00:00:00.000Z' },
    }

    expect(isApiSuccess(response)).toBe(false)
  })

  it('错误码取值稳定', () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR')
    expect(Object.values(ErrorCode)).toHaveLength(8)
    expect(ErrorCode.CONFLICT).toBe('CONFLICT')
  })
})
