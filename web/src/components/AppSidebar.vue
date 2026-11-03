<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Boxes, PanelLeftClose, PanelLeftOpen } from '@lucide/vue'
import { navigationGroups } from '@/config/navigation'
import { useAppStore } from '@/stores/app'
import { useMediaQuery } from '@/composables/useMediaQuery'

const route = useRoute()
const app = useAppStore()

// 窄屏下侧栏是抽屉，不存在「折叠成图标条」的形态，否则点了也看不见文字
const narrow = useMediaQuery('(max-width: 960px)')
const collapsed = computed(() => app.sidebarCollapsed && !narrow.matches)
const drawerOpen = computed(() => narrow.matches && app.sidebarOpen)

function isActive(to: string): boolean {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <aside class="sidebar" :class="{ 'is-collapsed': collapsed, 'is-drawer-open': drawerOpen }">
    <div class="brand">
      <div class="brand-mark">
        <Boxes :size="18" />
      </div>
      <div v-if="!collapsed" class="brand-text">
        <strong>WebCrawler</strong>
        <span>插件化采集平台</span>
      </div>
    </div>

    <nav class="nav">
      <template v-for="group in navigationGroups" :key="group.label">
        <p v-if="!collapsed" class="nav-group">{{ group.label }}</p>
        <RouterLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ 'is-active': isActive(item.to) }"
          :title="collapsed ? item.label : undefined"
          @click="app.closeSidebar()"
        >
          <component :is="item.icon" :size="17" class="nav-icon" />
          <span v-if="!collapsed" class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </template>
    </nav>

    <div v-if="!narrow.matches" class="sidebar-footer">
      <button class="collapse-btn" type="button" @click="app.toggleSidebar()">
        <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" :size="16" />
        <span v-if="!collapsed">收起侧栏</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--wb-sidebar-width);
  flex: 0 0 var(--wb-sidebar-width);
  height: 100vh;
  position: sticky;
  top: 0;
  background: var(--wb-surface);
  border-right: 1px solid var(--wb-border);
  transition: width 0.18s ease, flex-basis 0.18s ease;
}

.sidebar.is-collapsed {
  width: var(--wb-sidebar-collapsed);
  flex-basis: var(--wb-sidebar-collapsed);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--wb-header-height);
  padding: 0 16px;
  border-bottom: 1px solid var(--wb-border);
  flex: 0 0 auto;
}

.is-collapsed .brand {
  justify-content: center;
  padding: 0;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(135deg, var(--wb-primary), #5b8bff);
  box-shadow: 0 4px 12px rgba(47, 107, 255, 0.28);
  flex: 0 0 auto;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  overflow: hidden;
}

.brand-text strong {
  font-size: 14.5px;
  letter-spacing: 0.2px;
}

.brand-text span {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.nav {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 10px;
}

.nav-group {
  padding: 0 8px;
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--wb-text-muted);
}

.nav-group:first-child {
  margin-top: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 10px;
  margin-bottom: 2px;
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text-secondary);
  font-size: 13.5px;
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
}

.is-collapsed .nav-item {
  justify-content: center;
  padding: 0;
}

.nav-item:hover {
  background: var(--wb-surface-muted);
  color: var(--wb-text);
}

.nav-item.is-active {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}

.nav-icon {
  flex: 0 0 auto;
}

.sidebar-footer {
  padding: 10px;
  border-top: 1px solid var(--wb-border);
}

.collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  font-size: 12.5px;
  cursor: pointer;
}

.collapse-btn:hover {
  background: var(--wb-surface-muted);
  color: var(--wb-text);
}

/*
 * 窄屏：侧栏变成覆盖式抽屉。
 * 默认移出视口，靠顶栏汉堡按钮唤出；展开时给主内容让出阴影与遮罩。
 * 之前只改成 fixed 而没做位移与遮罩，结果侧栏常驻盖住页面左侧。
 */
@media (max-width: 960px) {
  .sidebar {
    position: fixed;
    z-index: 40;
    left: 0;
    top: 0;
    width: var(--wb-sidebar-width);
    flex-basis: auto;
    transform: translateX(-100%);
    transition: transform 0.22s ease, box-shadow 0.22s ease;
    box-shadow: none;
  }

  .sidebar.is-drawer-open {
    transform: translateX(0);
    box-shadow: var(--wb-shadow-md);
  }
}
</style>
