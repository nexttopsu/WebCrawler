import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'webcrawler:theme'

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // 隐私模式下 localStorage 可能不可用，退回默认
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

/**
 * 主题。
 *
 * 三态：浅色 / 暗色 / 跟随系统。实际生效值写到 `<html class="dark">`，
 * Element Plus 与我们的 CSS 变量都挂在这个类上，因此只需切换一次。
 */
export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readStoredMode())
  const systemDark = ref(systemPrefersDark())

  const isDark = computed(() => mode.value === 'dark' || (mode.value === 'system' && systemDark.value))

  function apply(): void {
    const root = document.documentElement
    root.classList.toggle('dark', isDark.value)
    root.dataset.theme = isDark.value ? 'dark' : 'light'
  }

  function setMode(next: ThemeMode): void {
    mode.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 存不下不影响当前会话
    }
  }

  /** 在浅色与暗色之间切换（跟随系统时切到与当前相反的一侧）。 */
  function toggle(): void {
    setMode(isDark.value ? 'light' : 'dark')
  }

  function listenSystem(): void {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    media.addEventListener('change', (event) => {
      systemDark.value = event.matches
    })
  }

  watch(isDark, apply, { immediate: true })

  return { mode, isDark, systemDark, setMode, toggle, listenSystem, apply }
})
