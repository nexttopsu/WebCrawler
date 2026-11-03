import { ref } from 'vue'
import { defineStore } from 'pinia'

const COLLAPSE_KEY = 'webcrawler:sidebar-collapsed'

/**
 * 应用级 UI 状态。
 *
 * 只放「跨页面共享的界面状态」，业务数据仍由各页面自己持有，
 * 避免把服务端数据塞进 store 后难以判断新鲜度。
 */
export const useAppStore = defineStore('app', () => {
  const sidebarCollapsed = ref(readCollapsed())
  /** 窄屏抽屉是否展开。宽屏下不生效，只服务于 ≤960px 的覆盖式侧栏。 */
  const sidebarOpen = ref(false)
  /** 全局刷新计数：设置页保存后通知仪表盘等页面重新拉数据 */
  const dataVersion = ref(0)

  function readCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
    try {
      localStorage.setItem(COLLAPSE_KEY, sidebarCollapsed.value ? '1' : '0')
    } catch {
      // 忽略存储失败
    }
  }

  function bumpDataVersion(): void {
    dataVersion.value += 1
  }

  function toggleSidebarOpen(): void {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar(): void {
    sidebarOpen.value = false
  }

  return {
    sidebarCollapsed,
    sidebarOpen,
    dataVersion,
    toggleSidebar,
    toggleSidebarOpen,
    closeSidebar,
    bumpDataVersion,
  }
})
