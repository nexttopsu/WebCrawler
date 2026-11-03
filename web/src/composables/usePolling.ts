import { onBeforeUnmount, ref } from 'vue'

/**
 * 定时轮询。
 *
 * 任务进度必须来自后端：这里只负责「按节奏再问一次」，
 * 页面关闭或条件结束时立刻停表，避免后台空转。
 */
export function usePolling(callback: () => void | Promise<void>, intervalMs = 3000) {
  const active = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null

  function stop(): void {
    active.value = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function start(): void {
    if (active.value) return
    active.value = true
    timer = setInterval(() => {
      void callback()
    }, intervalMs)
  }

  /** 立即执行一次再开始计时。 */
  async function startNow(): Promise<void> {
    await callback()
    start()
  }

  onBeforeUnmount(stop)

  return { active, start, startNow, stop }
}
