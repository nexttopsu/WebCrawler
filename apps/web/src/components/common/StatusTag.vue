<script setup lang="ts">
/**
 * 状态标签。
 *
 * 统一任务 / 站点 / 代理 / 插件的状态配色，避免每页各写一套颜色映射。
 * 未登记的取值会原样展示为中性标签，不会静默丢掉信息。
 */
import { computed } from 'vue'

export type StatusTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const props = withDefaults(
  defineProps<{
    status: string | null | undefined
    label?: string
    /** 自定义映射：状态值 → 文案 / 色调 */
    map?: Record<string, { label: string; tone: StatusTone }>
    dot?: boolean
  }>(),
  { dot: true },
)

const DEFAULT_MAP: Record<string, { label: string; tone: StatusTone }> = {
  // 任务
  pending: { label: '排队中', tone: 'info' },
  running: { label: '执行中', tone: 'primary' },
  paused: { label: '已暂停', tone: 'warning' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  // 站点 / 栏目 / 规则
  active: { label: '启用', tone: 'success' },
  inactive: { label: '停用', tone: 'neutral' },
  // 代理
  available: { label: '可用', tone: 'success' },
  unavailable: { label: '不可用', tone: 'danger' },
  unknown: { label: '未检测', tone: 'neutral' },
  disabled: { label: '已禁用', tone: 'neutral' },
  // 插件
  enabled: { label: '已启用', tone: 'success' },
  incompatible: { label: '不兼容', tone: 'warning' },
  invalid: { label: '加载失败', tone: 'danger' },
  // 日志级别
  debug: { label: 'DEBUG', tone: 'neutral' },
  info: { label: 'INFO', tone: 'info' },
  warn: { label: 'WARN', tone: 'warning' },
  error: { label: 'ERROR', tone: 'danger' },
}

const resolved = computed(() => {
  const key = props.status ?? ''
  const entry = props.map?.[key] ?? DEFAULT_MAP[key]
  if (entry) return entry
  return { label: props.status ? String(props.status) : '—', tone: 'neutral' as StatusTone }
})
</script>

<template>
  <span class="status-tag" :class="`is-${resolved.tone}`">
    <span v-if="dot" class="status-tag__dot" />
    {{ label ?? resolved.label }}
  </span>
</template>

<style scoped>
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--wb-neutral-soft);
  color: var(--wb-neutral);
}

.status-tag__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.is-primary {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}
.is-success {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.is-warning {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.is-danger {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}
.is-info {
  background: var(--wb-info-soft);
  color: var(--wb-info);
}
.is-neutral {
  background: var(--wb-neutral-soft);
  color: var(--wb-text-secondary);
}
</style>
