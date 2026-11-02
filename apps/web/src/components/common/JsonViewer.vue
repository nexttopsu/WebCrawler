<script setup lang="ts">
/**
 * JSON 查看器：格式化展示 + 一键复制。
 * 用于规则配置、任务快照、文章 JSON、日志 detail。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Copy, Download } from '@lucide/vue'

const props = withDefaults(
  defineProps<{
    value: unknown
    maxHeight?: number
    filename?: string
    wrap?: boolean
  }>(),
  { maxHeight: 420, wrap: true },
)

const copied = ref(false)

const text = computed(() => {
  const value = props.value
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') {
    // 字符串若是 JSON 文本，格式化后再展示，避免一坨压缩后的内容
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
})

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text.value)
    copied.value = true
    ElMessage.success('已复制到剪贴板')
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选择复制')
  }
}

function download(): void {
  const blob = new Blob([text.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = props.filename ?? 'data.json'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}
</script>

<template>
  <div class="json-viewer">
    <div class="json-viewer__bar">
      <span class="wb-muted">JSON</span>
      <span class="json-viewer__spacer" />
      <button class="json-viewer__action" type="button" @click="copy">
        <component :is="copied ? Check : Copy" :size="13" />
        复制
      </button>
      <button v-if="filename" class="json-viewer__action" type="button" @click="download">
        <Download :size="13" />
        下载
      </button>
    </div>
    <pre
      class="wb-code json-viewer__body"
      :style="{ maxHeight: `${maxHeight}px`, whiteSpace: wrap ? 'pre-wrap' : 'pre' }"
      >{{ text || '（空）' }}</pre
    >
  </div>
</template>

<style scoped>
.json-viewer {
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
  overflow: hidden;
  background: var(--wb-surface-muted);
}

.json-viewer__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface);
}

.json-viewer__spacer {
  flex: 1;
}

.json-viewer__action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.json-viewer__action:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}

.json-viewer__body {
  border: 0;
  border-radius: 0;
  max-height: 420px;
}
</style>
