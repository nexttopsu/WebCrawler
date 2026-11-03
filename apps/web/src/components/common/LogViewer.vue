<script setup lang="ts">
/**
 * 日志查看器。
 *
 * 每条日志一行：时间 / 级别 / 阶段 / 消息，点开看 detail。
 * 「复制」只复制单条文本，避免把整页日志写进剪贴板。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { LogEntryDto } from '@webcrawler/shared'
import { ChevronDown, Copy } from '@lucide/vue'
import EmptyState from './EmptyState.vue'
import StatusTag from './StatusTag.vue'

const props = withDefaults(
  defineProps<{
    logs: LogEntryDto[]
    maxHeight?: number
    compact?: boolean
  }>(),
  { maxHeight: 480, compact: false },
)

const expanded = ref<Set<number>>(new Set())

const sorted = computed(() => props.logs)

function toggle(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function copy(log: LogEntryDto): Promise<void> {
  const detail = log.detail ? ` ${JSON.stringify(log.detail)}` : ''
  const text = `[${log.createdAt}] ${log.level.toUpperCase()} ${log.stage} ${log.message}${detail}`
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制该条日志')
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问')
  }
}
</script>

<template>
  <div class="log-viewer" :class="{ 'is-compact': compact }" :style="{ maxHeight: `${maxHeight}px` }">
    <EmptyState v-if="sorted.length === 0" compact title="没有匹配的日志" description="调整筛选条件后再试" />

    <article v-for="log in sorted" :key="log.id" class="log-row" :class="`is-${log.level}`">
      <div class="log-row__head" @click="toggle(log.id)">
        <span class="log-row__time wb-mono">{{ formatTime(log.createdAt) }}</span>
        <StatusTag :status="log.level" :dot="false" />
        <span class="wb-tag log-row__stage">{{ log.stage }}</span>
        <span class="log-row__message">{{ log.message }}</span>
        <button class="log-row__btn" type="button" title="复制" @click.stop="copy(log)">
          <Copy :size="13" />
        </button>
        <ChevronDown
          :size="14"
          class="log-row__chevron"
          :class="{ 'is-open': expanded.has(log.id) }"
        />
      </div>

      <div v-if="expanded.has(log.id)" class="log-row__detail">
        <p v-if="log.url" class="log-row__url wb-mono">{{ log.url }}</p>
        <pre v-if="log.detail" class="wb-code">{{ JSON.stringify(log.detail, null, 2) }}</pre>
        <p v-else class="wb-muted log-row__nohint">该条日志没有附加信息</p>
      </div>
    </article>
  </div>
</template>

<style scoped>
.log-viewer {
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
}

.log-row {
  border-bottom: 1px solid var(--wb-border);
}

.log-row:last-child {
  border-bottom: 0;
}

.log-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 12.5px;
}

.log-row__head:hover {
  background: var(--wb-surface-hover);
}

.log-row__time {
  color: var(--wb-text-muted);
  flex: 0 0 auto;
}

.log-row__stage {
  flex: 0 0 auto;
  text-transform: lowercase;
}

.log-row__message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-text);
}

.is-error .log-row__message {
  color: var(--wb-danger);
}

.is-warn .log-row__message {
  color: var(--wb-warning);
}

.log-row__btn {
  border: 0;
  background: transparent;
  color: var(--wb-text-muted);
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 2px;
}

.log-row__btn:hover {
  color: var(--wb-primary);
}

.log-row__chevron {
  color: var(--wb-text-muted);
  transition: transform 0.15s ease;
}

.log-row__chevron.is-open {
  transform: rotate(180deg);
}

.log-row__detail {
  padding: 0 12px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-row__url {
  color: var(--wb-text-secondary);
  word-break: break-all;
}

.log-row__nohint {
  font-size: 12px;
}

.is-compact .log-row__head {
  padding: 6px 8px;
}
</style>
