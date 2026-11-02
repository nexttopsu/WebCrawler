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
    itemSelector: string
    linkSelector: string
    titleSelector: string
    paginationType: 'none' | 'query' | 'path' | 'next' | 'cursor'
    paginationParameter: string
    /** path 模式模板，如 /page/{page} */
    paginationPathPattern: string
    maxPages: number | null
  }
  /** 详情字段配置（与 Rule Schema 的 FieldRule 一致） */
  fields: TesterFieldDraft[]
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
      itemSelector: '',
      linkSelector: '',
      titleSelector: '',
      paginationType: 'none',
      paginationParameter: 'page',
      paginationPathPattern: '/page/{page}',
      maxPages: null,
    },
    fields: [],
  }
}

export function loadTesterDraft(): TesterDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isValidDraft(parsed)) return null
    return parsed
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
