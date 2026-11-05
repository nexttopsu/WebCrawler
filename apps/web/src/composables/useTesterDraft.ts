import { ref, watch, type Ref } from 'vue'

/**
 * 测试器草稿持久化。
 *
 * 任务书允许「经过容量和安全限制的本地存储」：
 * - 只存规则配置与界面状态，绝不存代理凭据（代理只存 proxyId 引用）；
 * - 序列化后超过 DRAFT_MAX_BYTES 直接拒绝写入并提示（不静默丢数据）；
 * - 读取时做结构校验与版本检查，损坏或过期草稿按无草稿处理。
 */

const DRAFT_KEY = 'webcrawler.tester-draft'
const DRAFT_VERSION = 1

/** 草稿体积上限（localStorage 键值通常 5 MB，这里取保守值）。 */
export const DRAFT_MAX_BYTES = 512 * 1024

/** 草稿内容。任何字段缺失都视为「没有可用草稿」。 */
export interface TesterDraft {
  version: number
  savedAt: string
  url: string
  mode: 'http' | 'browser'
  proxyId: number | null
  /** 列表模式配置 */
  list: {
    /** 列表插件 id：选中后由插件解析列表页，无需 itemSelector 与列表字段 */
    plugin: string
    itemSelector: string
    /** 列表阶段的解析器插件链（与详情阶段的顶层 parserPlugins 互不影响） */
    parserPlugins: string[]
    /** 列表阶段排除选择器：字段提取前先删除命中的节点（优先级最高，可不填） */
    excludeSelectors: string[]
    /** 列表字段配置（推荐写法）：title / url 必填，其余自定义 */
    listFields: TesterFieldDraft[]
    paginationType: 'none' | 'query' | 'path' | 'next' | 'cursor'
    paginationParameter: string
    /** path 模式模板，如 /page/{page} */
    paginationPathPattern: string
    maxPages: number | null
  }
  /** 详情字段配置（与 Rule Schema 的 FieldRule 一致） */
  fields: TesterFieldDraft[]
  /** 详情插件 id：选中后由插件解析详情页，无需字段配置 */
  detailPlugin: string
  /** 详情阶段的解析器插件链（写入规则顶层 parserPlugins，与列表互不影响） */
  parserPlugins: string[]
  /** 详情阶段排除选择器：字段提取前先删除命中的节点（优先级最高，可不填） */
  excludeSelectors: string[]
  /** 采集范围：full = 列表 + 详情（缺省），list = 仅列表；写入 config.collectScope */
  collectScope: 'full' | 'list'
}

export interface TesterFieldDraft {
  key: string
  label: string
  selector: string
  type: 'text' | 'html' | 'attr'
  attribute: string
  multiple: boolean
  required: boolean
  defaultValue: string
  trim: boolean
  collapseWhitespace: boolean
  enabled: boolean
}

function isValidDraft(value: unknown): value is TesterDraft {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === DRAFT_VERSION &&
    typeof record.url === 'string' &&
    Array.isArray(record.fields) &&
    typeof record.list === 'object' &&
    record.list !== null
  )
}

export function createEmptyDraft(): TesterDraft {
  return {
    version: DRAFT_VERSION,
    savedAt: new Date().toISOString(),
    url: '',
    mode: 'http',
    proxyId: null,
    list: {
      plugin: '',
      itemSelector: '',
      parserPlugins: [],
      excludeSelectors: [],
      listFields: [],
      paginationType: 'none',
      paginationParameter: 'page',
      paginationPathPattern: '/page/{page}',
      maxPages: null,
    },
    fields: [],
    detailPlugin: '',
    parserPlugins: [],
    excludeSelectors: [],
    collectScope: 'full',
  }
}

/** 合法的分页方式，用于把旧草稿里的非法值收敛回默认。 */
const PAGINATION_TYPES: ReadonlyArray<TesterDraft['list']['paginationType']> = [
  'none',
  'query',
  'path',
  'next',
  'cursor',
]

export function loadTesterDraft(): TesterDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isValidDraft(parsed)) return null

    // 旧版本草稿可能缺少后来新增的字段。注意：`undefined` 会盖掉默认值，
    // 所以每个标量字段都显式兜底——否则渲染时对 undefined 调 `.trim()` 会整页白屏。
    const defaults = createEmptyDraft()
    const list = parsed.list as unknown as Record<string, unknown>
    const stringOf = (source: Record<string, unknown>, key: string, fallback: string): string =>
      typeof source[key] === 'string' ? (source[key] as string) : fallback
    const namesOf = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

    const paginationType = list.paginationType as TesterDraft['list']['paginationType']

    return {
      ...defaults,
      ...parsed,
      url: typeof parsed.url === 'string' ? parsed.url : '',
      mode: parsed.mode === 'browser' ? 'browser' : 'http',
      proxyId: typeof parsed.proxyId === 'number' ? parsed.proxyId : null,
      list: {
        ...defaults.list,
        plugin: stringOf(list, 'plugin', ''),
        itemSelector: stringOf(list, 'itemSelector', ''),
        paginationType: PAGINATION_TYPES.includes(paginationType) ? paginationType : 'none',
        paginationParameter: stringOf(list, 'paginationParameter', defaults.list.paginationParameter),
        paginationPathPattern: stringOf(list, 'paginationPathPattern', defaults.list.paginationPathPattern),
        maxPages: typeof list.maxPages === 'number' ? list.maxPages : null,
        parserPlugins: namesOf(list.parserPlugins),
        excludeSelectors: namesOf(list.excludeSelectors),
        listFields: Array.isArray(list.listFields) ? (list.listFields as TesterFieldDraft[]) : [],
      },
      fields: parsed.fields,
      // 旧草稿没有插件字段（undefined），按空串处理
      detailPlugin: typeof parsed.detailPlugin === 'string' ? parsed.detailPlugin : '',
      parserPlugins: namesOf(parsed.parserPlugins),
      excludeSelectors: namesOf(parsed.excludeSelectors),
      collectScope: parsed.collectScope === 'list' ? 'list' : 'full',
    }
  } catch {
    // 草稿损坏不应阻塞页面
    return null
  }
}

export function saveTesterDraft(draft: TesterDraft): { ok: boolean; reason?: string } {
  try {
    const raw = JSON.stringify(draft)
    // 粗略按 UTF-16 计量（localStorage 以 UTF-16 存储字符串）
    if (raw.length * 2 > DRAFT_MAX_BYTES) {
      return { ok: false, reason: `草稿超过 ${Math.round(DRAFT_MAX_BYTES / 1024)} KB 上限，未保存` }
    }
    localStorage.setItem(DRAFT_KEY, raw)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '草稿保存失败' }
  }
}

export function clearTesterDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* 忽略清理失败 */
  }
}

/**
 * 草稿状态 + 自动保存（800ms 节流）。
 *
 * `hasUnsavedChanges` 供路由守卫 / beforeunload 提示「有未保存修改」；
 * 自动保存失败（超限）不重置脏标记，确保提示不会被吞掉。
 */
export function useTesterDraft(draft: Ref<TesterDraft>) {
  const hasUnsavedChanges = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function markDirty(): void {
    hasUnsavedChanges.value = true
  }

  function flush(): boolean {
    const result = saveTesterDraft(draft.value)
    if (result.ok) hasUnsavedChanges.value = false
    return result.ok
  }

  watch(draft, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => flush(), 800)
  }, { deep: true })

  return { hasUnsavedChanges, markDirty, flush }
}
