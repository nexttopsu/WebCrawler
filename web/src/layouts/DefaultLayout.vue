<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import { useAppStore } from '@/stores/app'
import { useMediaQuery } from '@/composables/useMediaQuery'

const app = useAppStore()
const route = useRoute()
const narrow = useMediaQuery('(max-width: 960px)')

/** 抽屉展开时锁住背景滚动，避免遮罩后面还能滚。 */
watch(
  () => app.sidebarOpen,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : ''
  },
)

watch(
  () => route.fullPath,
  () => app.closeSidebar(),
)

onBeforeUnmount(() => {
  document.body.style.overflow = ''
})
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <!-- 窄屏抽屉的遮罩：点空白处关闭，宽屏不渲染 -->
    <div
      v-if="narrow.matches && app.sidebarOpen"
      class="backdrop"
      role="button"
      tabindex="-1"
      aria-label="关闭菜单"
      @click="app.closeSidebar()"
    />
    <div class="main">
      <AppHeader />
      <main class="content">
        <RouterView v-slot="{ Component, route: current }">
          <component :is="Component" :key="current.fullPath" />
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  background: var(--wb-bg);
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 35;
  background: rgba(15, 20, 32, 0.42);
  backdrop-filter: blur(1px);
  animation: fade-in 0.18s ease;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  padding: 20px 24px 32px;
  max-width: var(--wb-content-max);
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 960px) {
  .content {
    padding: 14px 12px 24px;
  }
}
</style>
