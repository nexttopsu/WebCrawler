import { computed, ref } from 'vue'
import type { CategoryTreeNodeDto } from '@webcrawler/shared'
import { errorMessage } from '@/api/client'
import { listCategoryTree } from '@/api/categories'

/**
 * 全量栏目树的共享加载逻辑（模块级单例）。
 *
 * 栏目是配置数据、量级小，所有页面统一拉一次全量树再各自派生：
 * - `tree`：嵌套结构（树表用）；
 * - `pathMap`：id → 完整层级路径「剧院动态 / 儿艺新闻」；
 * - `ancestorPathMap`：id → 上级路径（不含自身）。
 *
 * `load()` 总是重新拉取：新建 / 编辑 / 删除栏目后调用即可刷新所有使用方。
 * 并发调用会合并成同一次请求。
 */
const tree = ref<CategoryTreeNodeDto[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let inflight: Promise<void> | null = null

function fetchTree(): Promise<void> {
  if (inflight) return inflight
  loading.value = true
  inflight = listCategoryTree()
    .then((data) => {
      tree.value = data
      error.value = null
    })
    .catch((cause: unknown) => {
      tree.value = []
      error.value = errorMessage(cause)
    })
    .finally(() => {
      loading.value = false
      inflight = null
    })
  return inflight
}

export function useCategoryTree() {
  function load(): Promise<void> {
    return fetchTree()
  }

  /** id → 完整路径（含自身），根栏目就是自己的名称。 */
  const pathMap = computed(() => {
    const map = new Map<number, string>()
    const walk = (nodes: CategoryTreeNodeDto[], prefix: string): void => {
      for (const node of nodes) {
        const path = prefix ? `${prefix} / ${node.name}` : node.name
        map.set(node.id, path)
        walk(node.children, path)
      }
    }
    walk(tree.value, '')
    return map
  })

  /** id → 上级路径（不含自身），根栏目为空串。 */
  const ancestorPathMap = computed(() => {
    const map = new Map<number, string>()
    const walk = (nodes: CategoryTreeNodeDto[], prefix: string): void => {
      for (const node of nodes) {
        map.set(node.id, prefix)
        walk(node.children, prefix ? `${prefix} / ${node.name}` : node.name)
      }
    }
    walk(tree.value, '')
    return map
  })

  /** id → 所属站点 id，用于从选中的栏目反推站点。 */
  const categorySiteMap = computed(() => {
    const map = new Map<number, number>()
    const walk = (nodes: CategoryTreeNodeDto[]): void => {
      for (const node of nodes) {
        map.set(node.id, node.siteId)
        walk(node.children)
      }
    }
    walk(tree.value)
    return map
  })

  return { tree, loading, error, load, pathMap, ancestorPathMap, categorySiteMap }
}
