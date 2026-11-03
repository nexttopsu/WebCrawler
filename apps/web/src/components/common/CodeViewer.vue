<script setup lang="ts">
/** 代码查看器：只读展示 + 复制，可选行号与自动换行开关。 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Copy } from '@lucide/vue'

const props = withDefaults(
  defineProps<{
    code: string
    label?: string
    maxHeight?: number
    showLineNumbers?: boolean
    wrap?: boolean
  }>(),
  { label: '源码', maxHeight: 480, showLineNumbers: false, wrap: false },
)

const copied = ref(false)
const lines = computed(() => props.code.split('\n'))

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    ElMessage.success('已复制')
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问')
  }
}
</script>

<template>
  <div class="code-viewer">
    <div class="code-viewer__bar">
      <span class="wb-muted">{{ label }}</span>
      <span class="code-viewer__size">{{ code.length.toLocaleString() }} 字符</span>
      <span class="code-viewer__spacer" />
      <button class="code-viewer__action" type="button" @click="copy">
        <component :is="copied ? Check : Copy" :size="13" />
        复制
      </button>
    </div>
    <div class="code-viewer__body" :style="{ maxHeight: `${maxHeight}px` }">
      <table v-if="showLineNumbers" class="code-viewer__table">
        <tbody>
          <tr v-for="(line, index) in lines" :key="index">
            <td class="code-viewer__lineno">{{ index + 1 }}</td>
            <td class="code-viewer__line" :class="{ 'is-wrap': wrap }">{{ line || ' ' }}</td>
          </tr>
        </tbody>
      </table>
      <pre v-else class="wb-code code-viewer__pre" :class="{ 'is-wrap': wrap }">{{ code }}</pre>
    </div>
  </div>
</template>

<style scoped>
.code-viewer {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  overflow: hidden;
  background: var(--wb-surface-muted);
}

.code-viewer__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--wb-surface);
  border-bottom: 1px solid var(--wb-border);
}

.code-viewer__size {
  color: var(--wb-text-muted);
  font-size: 11.5px;
}

.code-viewer__spacer {
  flex: 1;
}

.code-viewer__action {
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

.code-viewer__action:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}

.code-viewer__body {
  overflow: auto;
}

.code-viewer__pre {
  border: 0;
  border-radius: 0;
  margin: 0;
}

.code-viewer__pre.is-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}

.code-viewer__table {
  border-collapse: collapse;
  width: 100%;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.65;
}

.code-viewer__lineno {
  width: 1%;
  padding: 0 10px;
  text-align: right;
  color: var(--wb-text-muted);
  user-select: none;
  border-right: 1px solid var(--wb-border);
  vertical-align: top;
}

.code-viewer__line {
  padding: 0 12px;
  color: var(--wb-text-secondary);
  white-space: pre;
}

.code-viewer__line.is-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
