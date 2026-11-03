import { reactive, ref, watch } from 'vue'
import type { PaginatedData } from '@webcrawler/shared'
import { errorMessage } from '@/api/client'

export interface ListQueryOptions {
  pageSize?: number
  /** 是否在创建后立即加载 */
  immediate?: boolean
  /** 每次请求前把空字符串 / undefined 过滤掉 */
  debounceMs?: number
}

/**
 * 列表页通用状态：分页 + 筛选 + 加载/错误。
 *
 * 只保留最后一次请求的结果（序号守卫），避免快速切换筛选时旧响应覆盖新数据。
 */
export function useListQuery<T, F extends Record<string, unknown>>(
  fetcher: (params: { page: number; pageSize: number } & F) => Promise<PaginatedData<T>>,
  initialFilters: F,
  options: ListQueryOptions = {},
) {
  const page = ref(1)
  const pageSize = ref(options.pageSize ?? 20)
  const rows = ref<T[]>([]) as { value: T[] }
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const filters = reactive({ ...initialFilters }) as F

  let seq = 0

  function params(): { page: number; pageSize: number } & F {
    return { page: page.value, pageSize: pageSize.value, ...filters }
  }

  async function load(): Promise<void> {
    const current = ++seq
    loading.value = true
    error.value = null
    try {
      const result = await fetcher(params())
      if (current !== seq) return
      rows.value = result.items as T[]
      total.value = result.total
      // 删除最后一页最后一条后页码可能越界，回退一页重查
      if (result.items.length === 0 && result.total > 0 && page.value > 1) {
        page.value = Math.max(1, Math.ceil(result.total / pageSize.value))
        await load()
      }
    } catch (cause) {
      if (current === seq) {
        error.value = errorMessage(cause)
        rows.value = []
        total.value = 0
      }
    } finally {
      if (current === seq) loading.value = false
    }
  }

  /** 条件变化后从第一页重新查。 */
  function search(): void {
    page.value = 1
    void load()
  }

  function reset(): void {
    for (const key of Object.keys(initialFilters)) {
      ;(filters as Record<string, unknown>)[key] = (initialFilters as Record<string, unknown>)[key]
    }
    search()
  }

  function setPage(value: number): void {
    page.value = value
  }

  function setPageSize(value: number): void {
    pageSize.value = value
    page.value = 1
  }

  /** 筛选条件是否偏离初始值（用于显示「重置」）。 */
  function isFiltered(): boolean {
    return Object.keys(initialFilters).some((key) => {
      const current = (filters as Record<string, unknown>)[key]
      const initial = (initialFilters as Record<string, unknown>)[key]
      return current !== initial && current !== '' && current !== undefined
    })
  }

  if (options.immediate !== false) void load()

  // 页面 size 变化时自动重查，省去每个页面手写 watch
  watch(pageSize, () => {
    if (page.value !== 1) return
  })

  return {
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    filters,
    load,
    search,
    reset,
    setPage,
    setPageSize,
    isFiltered,
  }
}
