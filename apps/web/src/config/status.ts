/** 与 StatusTag 一致的色调取值（不直接引 .vue，避免类型环依赖）。 */
type StatusTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

/**
 * 状态文案映射。
 *
 * 任务与文章都有 `pending`，语义完全不同（排队中 / 待处理），
 * 所以文章状态在这里单独声明，由使用方显式传给 StatusTag。
 */
export const ARTICLE_STATUS_MAP: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: '待处理', tone: 'warning' },
  published: { label: '已发布', tone: 'success' },
  ignored: { label: '已忽略', tone: 'neutral' },
}
