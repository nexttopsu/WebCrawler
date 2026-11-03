import type { CrawlRuleConfig } from './crawl.js'

/**
 * 规则继承的合并策略。
 *
 * 优先级：`网站默认规则 < 栏目覆盖规则 < 任务临时覆盖规则`。
 * 这里定义唯一的合并实现，服务端「生效规则」接口与后续任务执行都调用它，
 * 避免出现两套语义。
 *
 * 规则：
 * - 普通对象按 key 递归合并；
 * - 数组整体替换（不拼接、不去重）——`clean.removeSelectors`、`validate.requiredFields`
 *   这类配置的顺序与取舍由覆盖方完全决定，保留旧值反而会产生难以预期的组合；
 * - 标量覆盖；
 * - `null` 表示显式清除（当前仅 `request.proxy: null` 使用，含义是「强制直连」）；
 * - 覆盖方未出现的 key 继承基础值。
 *
 * 字段映射（`fields` / `detail.fields`）同样是普通对象，因此按字段名逐层合并：
 * 覆盖方只改 `title` 时，基础规则里的 `content` 等字段保持有效。
 */
export const RULE_MERGE_STRATEGY = [
  '对象按 key 递归合并',
  '数组整体替换',
  '标量覆盖',
  'null 清除（仅 request.proxy 允许）',
  'fields 按字段名逐层合并',
] as const

type JsonLike = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (override === null) return null
  if (Array.isArray(override)) return [...override]
  if (isPlainObject(override)) {
    const result: JsonLike = isPlainObject(base) ? { ...base } : {}
    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeValue(isPlainObject(base) ? base[key] : undefined, value)
    }
    return result
  }
  return override
}

/**
 * 归一化分页配置。
 *
 * `list.pagination` 是权威位置，`pagination` 是兼容别名（引擎读顶层字段）。
 * 归一化后两处指向同一份内容，且不修改入参。
 */
export function normalizeRuleConfig(config: CrawlRuleConfig): CrawlRuleConfig {
  const next = structuredClone(config) as CrawlRuleConfig

  // timeout 是 timeoutMs 的别名：折叠后只保留一个字段，避免两份值漂移
  if (next.request) {
    if (next.request.timeout !== undefined && next.request.timeoutMs === undefined) {
      next.request.timeoutMs = next.request.timeout
    }
    delete next.request.timeout
  }

  const pagination = next.list?.pagination ?? next.pagination

  if (!pagination) {
    if (next.list) delete next.list.pagination
    delete next.pagination
    return next
  }

  const copy = structuredClone(pagination)
  if (next.list) next.list.pagination = structuredClone(copy)
  next.pagination = copy
  return next
}

/**
 * 深度合并规则配置。
 *
 * 入参为 `undefined` 视作「该层没有配置」，返回另一侧；
 * 两侧都是 `undefined` 时返回最小可用配置。
 */
export function mergeRuleConfig(
  base: CrawlRuleConfig | null | undefined,
  override: CrawlRuleConfig | null | undefined,
): CrawlRuleConfig {
  if (!base && !override) {
    return { version: 1 }
  }
  if (!base) return normalizeRuleConfig(override as CrawlRuleConfig)
  if (!override) return normalizeRuleConfig(base)

  const left = normalizeRuleConfig(base)
  const right = normalizeRuleConfig(override)
  const merged = mergeValue(left, right) as CrawlRuleConfig
  merged.version = right.version ?? left.version
  return normalizeRuleConfig(merged)
}

/** 按优先级依次合并多份配置。 */
export function mergeRuleConfigChain(
  configs: ReadonlyArray<CrawlRuleConfig | null | undefined>,
): CrawlRuleConfig | null {
  const available = configs.filter((config): config is CrawlRuleConfig => Boolean(config))
  if (available.length === 0) return null

  return available.reduce<CrawlRuleConfig>(
    (accumulator, current) => mergeRuleConfig(accumulator, current),
    available[0] as CrawlRuleConfig,
  )
}

/** 判断两个 JSON 值是否深度相等（仅用于配置比较，不处理函数、Map 等）。 */
export function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => isDeepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => key in right && isDeepEqual(left[key], right[key]))
  }
  return false
}
