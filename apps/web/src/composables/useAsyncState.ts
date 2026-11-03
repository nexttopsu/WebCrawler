import { ref, shallowRef, type Ref } from 'vue'
import { errorMessage } from '@/api/client'

export interface AsyncState<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  run: () => Promise<T | null>
  reset: () => void
}

/**
 * 统一的异步加载状态。
 *
 * 页面只需要 `run()` 与三个状态，不必每个请求都写一遍 try/finally。
 * 错误只保留文案，避免把 axios 对象塞进响应式状态里。
 */
export function useAsyncState<T>(loader: () => Promise<T>, options: { immediate?: boolean } = {}): AsyncState<T> {
  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let seq = 0

  async function run(): Promise<T | null> {
    const current = ++seq
    loading.value = true
    error.value = null
    try {
      const result = await loader()
      // 并发请求只认最后一次，避免旧响应覆盖新数据
      if (current === seq) data.value = result
      return result
    } catch (cause) {
      if (current === seq) error.value = errorMessage(cause)
      return null
    } finally {
      if (current === seq) loading.value = false
    }
  }

  function reset(): void {
    data.value = null
    error.value = null
    loading.value = false
  }

  if (options.immediate !== false) void run()

  return { data, loading, error, run, reset }
}
