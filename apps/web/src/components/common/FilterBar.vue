<script setup lang="ts">
/**
 * 筛选栏：左侧筛选项、右侧重置与自定义操作。
 * 只负责排版与「是否有筛选条件」的提示，不持有状态。
 */
import { RotateCcw } from '@lucide/vue'

withDefaults(defineProps<{ active?: boolean; resetText?: string }>(), {
  active: false,
  resetText: '重置',
})
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__fields">
      <slot />
    </div>
    <div class="filter-bar__actions">
      <slot name="actions" />
      <el-button v-if="active" size="default" text @click="emit('reset')">
        <RotateCcw :size="14" />
        <span>{{ resetText }}</span>
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.filter-bar__fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.filter-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar__actions :deep(.el-button span) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
