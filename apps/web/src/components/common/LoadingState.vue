<script setup lang="ts">
/** 加载状态：骨架条，避免整页 spinner 造成的布局跳动。 */
withDefaults(defineProps<{ rows?: number; text?: string }>(), { rows: 3, text: '' })
</script>

<template>
  <div class="loading-state">
    <div v-for="index in rows" :key="index" class="loading-state__row">
      <span class="loading-state__bar" :style="{ width: `${92 - index * 12}%` }" />
    </div>
    <p v-if="text" class="loading-state__text">{{ text }}</p>
  </div>
</template>

<style scoped>
.loading-state {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
}

.loading-state__row {
  height: 14px;
  border-radius: 6px;
  background: var(--wb-surface-muted);
  overflow: hidden;
}

.loading-state__bar {
  display: block;
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, transparent, var(--wb-border), transparent);
  animation: shimmer 1.4s ease-in-out infinite;
}

.loading-state__text {
  font-size: 12.5px;
  color: var(--wb-text-muted);
  text-align: center;
}

@keyframes shimmer {
  0% {
    transform: translateX(-60%);
  }
  100% {
    transform: translateX(120%);
  }
}
</style>
