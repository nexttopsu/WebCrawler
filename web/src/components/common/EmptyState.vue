<script setup lang="ts">
/** 空状态：列表没有数据时给出下一步动作，而不是一片空白。 */
import type { Component } from 'vue'
import { Inbox } from '@lucide/vue'

withDefaults(
  defineProps<{
    title?: string
    description?: string
    icon?: Component
    compact?: boolean
  }>(),
  { title: '暂无数据', description: '', compact: false },
)
</script>

<template>
  <div class="empty-state" :class="{ 'is-compact': compact }">
    <span class="empty-state__icon">
      <component :is="icon ?? Inbox" :size="compact ? 20 : 26" />
    </span>
    <p class="empty-state__title">{{ title }}</p>
    <p v-if="description" class="empty-state__desc">{{ description }}</p>
    <div class="empty-state__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 16px;
  text-align: center;
}

.empty-state.is-compact {
  padding: 18px 12px;
}

.empty-state__icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: var(--wb-surface-muted);
  color: var(--wb-text-muted);
  border: 1px solid var(--wb-border);
}

.is-compact .empty-state__icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
}

.empty-state__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-text-secondary);
}

.empty-state__desc {
  font-size: 12.5px;
  color: var(--wb-text-muted);
  max-width: 420px;
}

.empty-state__actions:not(:empty) {
  margin-top: 6px;
}
</style>
