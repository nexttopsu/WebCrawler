<script setup lang="ts">
/** 错误状态：展示可读错误与重试入口，并把原始细节折叠起来方便排查。 */
import { computed, ref } from 'vue'
import { TriangleAlert, ChevronDown } from '@lucide/vue'

const props = defineProps<{
  message?: string
  details?: unknown
  compact?: boolean
  retryText?: string
}>()

const emit = defineEmits<{ retry: [] }>()

const expanded = ref(false)
const detailText = computed(() => {
  if (props.details === undefined || props.details === null) return ''
  try {
    return typeof props.details === 'string' ? props.details : JSON.stringify(props.details, null, 2)
  } catch {
    return String(props.details)
  }
})
</script>

<template>
  <div class="error-state" :class="{ 'is-compact': compact }">
    <span class="error-state__icon">
      <TriangleAlert :size="compact ? 18 : 22" />
    </span>
    <div class="error-state__body">
      <p class="error-state__title">{{ message || '加载失败' }}</p>
      <p class="error-state__desc">请检查后端服务是否可用，或稍后重试。</p>
      <div class="error-state__actions">
        <el-button size="small" type="primary" plain @click="emit('retry')">
          {{ retryText ?? '重试' }}
        </el-button>
        <el-button v-if="detailText" size="small" text @click="expanded = !expanded">
          详情
          <ChevronDown :size="14" :style="{ transform: expanded ? 'rotate(180deg)' : 'none' }" />
        </el-button>
      </div>
      <pre v-if="expanded && detailText" class="wb-code error-state__detail">{{ detailText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  gap: 12px;
  padding: 22px 20px;
  border-radius: var(--wb-radius);
  border: 1px solid var(--wb-danger-soft);
  background: var(--wb-danger-soft);
}

.error-state.is-compact {
  padding: 12px 14px;
}

.error-state__icon {
  color: var(--wb-danger);
  flex: 0 0 auto;
  margin-top: 1px;
}

.error-state__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-text);
}

.error-state__desc {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--wb-text-secondary);
}

.error-state__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.error-state__detail {
  margin-top: 10px;
  max-height: 220px;
}
</style>
