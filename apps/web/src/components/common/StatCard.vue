<script setup lang="ts">
import type { Component } from 'vue'
import { computed } from 'vue'

/** 统计卡片：一个指标 + 说明，可选图标与提示色。 */
const props = withDefaults(
  defineProps<{
    label: string
    value: string | number | null | undefined
    hint?: string
    icon?: Component
    tone?: 'primary' | 'success' | 'warning' | 'danger' | 'neutral'
    /** 没有数据时的占位文案，默认用 `—`，绝不显示假数字 */
    placeholder?: string
    loading?: boolean
  }>(),
  { tone: 'primary', placeholder: '—', loading: false },
)

const display = computed(() => {
  const value = props.value
  if (value === null || value === undefined || value === '') return props.placeholder
  return value
})

const tone = computed(() => props.tone)
</script>

<template>
  <div class="stat-card wb-card" :class="`is-${tone}`">
    <div class="stat-card__head">
      <span class="stat-card__label">{{ label }}</span>
      <span v-if="icon" class="stat-card__icon">
        <component :is="icon" :size="16" />
      </span>
    </div>
    <div class="stat-card__value">
      <span v-if="loading" class="stat-card__skeleton" />
      <template v-else>{{ display }}</template>
    </div>
    <p v-if="hint" class="stat-card__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.stat-card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 108px;
  border-left: 3px solid var(--wb-border);
}

.stat-card.is-primary {
  border-left-color: var(--wb-primary);
}
.stat-card.is-success {
  border-left-color: var(--wb-success);
}
.stat-card.is-warning {
  border-left-color: var(--wb-warning);
}
.stat-card.is-danger {
  border-left-color: var(--wb-danger);
}
.stat-card.is-neutral {
  border-left-color: var(--wb-border-strong);
}

.stat-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stat-card__label {
  font-size: 12.5px;
  color: var(--wb-text-muted);
}

.stat-card__icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

.is-success .stat-card__icon {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.is-warning .stat-card__icon {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.is-danger .stat-card__icon {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}
.is-neutral .stat-card__icon {
  background: var(--wb-neutral-soft);
  color: var(--wb-neutral);
}

.stat-card__value {
  font-size: 26px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: 0.3px;
  font-variant-numeric: tabular-nums;
}

.stat-card__skeleton {
  display: inline-block;
  width: 64px;
  height: 24px;
  border-radius: 6px;
  background: var(--wb-surface-muted);
  animation: pulse 1.2s ease-in-out infinite;
}

.stat-card__hint {
  font-size: 12px;
  color: var(--wb-text-muted);
}

@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}
</style>
