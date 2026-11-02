<script setup lang="ts">
import { computed } from 'vue'
import { Check, Copy, Loader2, Zap } from '@lucide/vue'

/** 点选结果的展示模型。 */
export interface SelectionInfo {
  tag: string
  id: string | null
  classes: string[]
  path: string
  outerHtml: string
}

const props = defineProps<{
  selection: SelectionInfo | null
  selector: string
  matchCount: number | null
  /** unique | multi | none | invalid | pending | idle */
  matchState: 'idle' | 'pending' | 'unique' | 'multi' | 'none' | 'invalid'
  checking: boolean
}>()

const emit = defineEmits<{
  'update:selector': [value: string]
  apply: []
  serverCheck: []
}>()

const matchLabel = computed(() => {
  switch (props.matchState) {
    case 'pending':
      return '校验中…'
    case 'unique':
      return `唯一匹配（${props.matchCount ?? 1}）`
    case 'multi':
      return `多匹配（${props.matchCount ?? 0}）`
    case 'none':
      return '无匹配'
    case 'invalid':
      return '选择器不合法'
    default:
      return '未验证'
  }
})

async function copySelector(): Promise<void> {
  if (!props.selector) return
  try {
    await navigator.clipboard.writeText(props.selector)
  } catch {
    // 剪贴板权限受限时静默；用户仍可手动复制输入框内容
  }
}
</script>

<template>
  <div class="selector-bar">
    <div v-if="selection" class="selection-info">
      <code class="sel-tag">&lt;{{ selection.tag }}&gt;</code>
      <code v-if="selection.id" class="sel-chip">#{{ selection.id }}</code>
      <code v-for="cls in selection.classes.slice(0, 4)" :key="cls" class="sel-chip">.{{ cls }}</code>
      <span class="sel-path" :title="selection.path">{{ selection.path }}</span>
    </div>
    <div v-else class="selection-info is-empty">在左侧预览中点击元素即可生成 Selector</div>

    <div class="selector-input">
      <el-input
        :model-value="selector"
        placeholder="CSS Selector（可手动修改后重新验证）"
        size="small"
        clearable
        @update:model-value="emit('update:selector', $event)"
        @keyup.enter="emit('apply')"
      />
      <el-button size="small" :icon="Zap" :disabled="!selector" @click="emit('apply')">应用</el-button>
      <el-button
        size="small"
        :loading="checking"
        :disabled="!selector"
        title="在服务端用真实文档验证（支持 XPath）"
        @click="emit('serverCheck')"
      >
        <Loader2 v-if="checking" :size="14" class="spin" />
        服务端验证
      </el-button>
      <el-button size="small" :icon="Copy" :disabled="!selector" @click="copySelector" />
      <span class="match-badge" :class="`is-${matchState}`">
        <Check v-if="matchState === 'unique'" :size="12" />
        {{ matchLabel }}
      </span>
    </div>

    <details v-if="selection?.outerHtml" class="nearby">
      <summary>选中元素附近 HTML</summary>
      <pre>{{ selection.outerHtml }}</pre>
    </details>
  </div>
</template>

<style scoped>
.selector-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--wb-border);
  background: var(--wb-surface-muted);
}

.selection-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--wb-text-secondary);
  min-height: 22px;
}

.selection-info.is-empty {
  color: var(--wb-text-muted);
}

.sel-tag {
  color: var(--wb-primary);
  font-weight: 600;
}

.sel-chip {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 11px;
}

.sel-path {
  margin-left: auto;
  color: var(--wb-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 45%;
  direction: rtl;
  text-align: left;
}

.selector-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.selector-input .el-input {
  flex: 1;
}

.match-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  color: var(--wb-text-muted);
}

.match-badge.is-unique {
  background: var(--wb-success-soft);
  border-color: transparent;
  color: var(--wb-success);
}

.match-badge.is-multi {
  background: #fff7e6;
  border-color: transparent;
  color: var(--wb-warning);
}

.match-badge.is-none,
.match-badge.is-invalid {
  background: var(--wb-danger-soft);
  border-color: transparent;
  color: var(--wb-danger);
}

.nearby {
  font-size: 12px;
}

.nearby summary {
  cursor: pointer;
  color: var(--wb-text-secondary);
}

.nearby pre {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
