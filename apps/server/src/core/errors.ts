/**
 * 解析与字段提取阶段的统一异常。
 *
 * 规则本身写错（选择器非法、字段类型不认识）与「页面里找不到元素」是两类问题：
 * 前者抛异常中断，后者作为字段级 `ok: false` 返回，不中断整篇文章的采集。
 */

/** 解析错误分类。 */
export const ParserErrorCode = {
  /** 选择器语法错误 */
  INVALID_SELECTOR: 'INVALID_SELECTOR',
  /** 字段规则本身不合法 */
  INVALID_FIELD_RULE: 'INVALID_FIELD_RULE',
  /** JSON 路径写法错误 */
  INVALID_JSON_PATH: 'INVALID_JSON_PATH',
  /** 文档无法解析 */
  PARSE_FAILED: 'PARSE_FAILED',
} as const
export type ParserErrorCode = (typeof ParserErrorCode)[keyof typeof ParserErrorCode]

/** 解析异常。 */
export class ParserError extends Error {
  override readonly name = 'ParserError'

  constructor(
    readonly code: ParserErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
