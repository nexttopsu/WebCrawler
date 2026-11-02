<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Menu,
  Moon,
  RefreshCw,
  Sun,
  UserRound,
} from '@lucide/vue'
import { navigation } from '@/config/navigation'
import { useSystemInfo } from '@/composables/useSystemInfo'
import { useThemeStore } from '@/stores/theme'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const { info, loading, error, online, load } = useSystemInfo()
const theme = useThemeStore()
const app = useAppStore()

/** 面包屑：分组 → 页面；详情页把 route.meta.crumb 追加在最后。 */
const crumbs = computed(() => {
  const current = navigation.find((item) => (item.to === '/' ? route.path === '/' : route.path.startsWith(item.to)))
  const list: Array<{ label: string; to?: string }> = []
  if (current) {
    list.push({ label: current.group })
    list.push({ label: current.label, to: route.path === current.to ? undefined : current.to })
  } else {
    list.push({ label: 'WebCrawler', to: '/' })
  }
  const crumb = route.meta.crumb as string | undefined
  if (crumb) list.push({ label: crumb })
  return list
})

const statusText = computed(() => (online.value ? '服务正常' : error.value ? '服务离线' : '连接中'))

onMounted(() => {
  void load()
})
</script>

<template>
  <header class="header">
    <!-- 窄屏才出现的抽屉入口，宽屏下侧栏常驻，不需要这个按钮 -->
    <button class="menu-btn" type="button" title="打开菜单" @click="app.toggleSidebarOpen()">
      <Menu :size="18" />
    </button>

    <nav class="crumbs" aria-label="面包屑">
      <template v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${index}`">
        <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb is-link">{{ crumb.label }}</RouterLink>
        <span v-else class="crumb">{{ crumb.label }}</span>
        <ChevronRight v-if="index < crumbs.length - 1" :size="13" class="crumb-sep" />
      </template>
    </nav>

    <div class="actions">
      <span class="status" :class="online ? 'is-online' : 'is-offline'" :title="statusText">
        <component :is="online ? CircleCheck : CircleAlert" :size="14" />
        <span class="status-text">{{ statusText }}</span>
      </span>

      <span v-if="info" class="wb-tag">v{{ info.version }}</span>

      <button
        class="icon-btn"
        type="button"
        :title="theme.isDark ? '切换到浅色主题' : '切换到暗色主题'"
        @click="theme.toggle()"
      >
        <component :is="theme.isDark ? Sun : Moon" :size="16" />
      </button>

      <button class="icon-btn" type="button" :disabled="loading" title="刷新系统信息" @click="load(true)">
        <RefreshCw :size="16" :class="{ spinning: loading }" />
      </button>

      <div class="user" title="未启用登录，预留用户区域">
        <UserRound :size="15" />
        <span>管理员</span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--wb-header-height);
  padding: 0 24px;
  background: color-mix(in srgb, var(--wb-surface) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--wb-border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  color: var(--wb-text-muted);
  overflow: hidden;
}

.crumb {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb:last-of-type {
  color: var(--wb-text);
  font-weight: 600;
}

.crumb.is-link:hover {
  color: var(--wb-primary);
}

.menu-btn {
  display: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-xs);
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  cursor: pointer;
}

.menu-btn:hover {
  color: var(--wb-text);
  background: var(--wb-surface-hover);
}

@media (max-width: 960px) {
  .header {
    padding: 0 14px;
    gap: 10px;
  }

  .menu-btn {
    display: inline-flex;
  }
}

@media (max-width: 720px) {
  .status-text,
  .user span {
    display: none;
  }

  .user {
    padding: 0 8px;
  }
}

.crumb-sep {
  color: var(--wb-text-muted);
  flex: 0 0 auto;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}

.status.is-online {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}

.status.is-offline {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.icon-btn:hover:not(:disabled) {
  background: var(--wb-surface-muted);
  color: var(--wb-text);
}

.icon-btn:disabled {
  cursor: progress;
  opacity: 0.7;
}

.user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--wb-border);
  color: var(--wb-text-secondary);
  font-size: 12.5px;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 860px) {
  .status-text,
  .user span {
    display: none;
  }
  .header {
    padding: 0 14px;
  }
}
</style>
