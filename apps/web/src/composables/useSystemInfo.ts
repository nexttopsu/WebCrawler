import { computed, ref } from 'vue'
import { fetchHealth, fetchSystemInfo } from '@/api/system'
import type { HealthPayload, SystemInfoPayload } from '@/api/types'

/**
 * 系统信息在布局与页面之间共享，模块级状态保证只加载一次。
 * 需要最新数据时调用 `load(true)`。
 */
const info = ref<SystemInfoPayload | null>(null)
const health = ref<HealthPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let initialized = false

export function useSystemInfo() {
  const online = computed(() => health.value?.status === 'ok')

  async function load(force = false): Promise<void> {
    if (loading.value) return
    if (initialized && !force) return

    loading.value = true
    error.value = null
    try {
      const [nextInfo, nextHealth] = await Promise.all([fetchSystemInfo(), fetchHealth()])
      info.value = nextInfo
      health.value = nextHealth
      initialized = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '加载系统信息失败'
    } finally {
      loading.value = false
    }
  }

  return { info, health, loading, error, online, load }
}
