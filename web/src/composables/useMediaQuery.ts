import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 媒体查询响应式布尔值。
 *
 * 用于「同一份模板在不同断点下行为不同」的场景（例如窄屏侧栏要从
 * 折叠态变成抽屉态），比在模板里堆 v-if 更直观，也能跟随窗口变化。
 */
export function useMediaQuery(query: string): { matches: Ref<boolean> } {
  const matches = ref(false)
  let mql: MediaQueryList | null = null

  const update = (event: MediaQueryListEvent | MediaQueryList): void => {
    matches.value = event.matches
  }

  onMounted(() => {
    mql = window.matchMedia(query)
    matches.value = mql.matches
    mql.addEventListener('change', update)
  })

  onBeforeUnmount(() => {
    mql?.removeEventListener('change', update)
    mql = null
  })

  return { matches }
}
