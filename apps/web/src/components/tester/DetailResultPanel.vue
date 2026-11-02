<script setup lang="ts">
import { computed } from 'vue'
import type { TesterDetailResultDto } from '@webcrawler/shared'
import { CheckCircle2, Copy, RefreshCw, XCircle } from '@lucide/vue'

const props = defineProps<{
  result: TesterDetailResultDto | null
  testing: boolean
  hasFields: boolean
}>()

const emit = defineEmits<{
  test: []
}>()

const resultJson = computed(() =>
  props.result ? JSON.stringify(props.result, null, 2) : '',
)

async function copyJson(): Promise<void> {
  if (!resultJson.value) return
  try {
    await navigator.clipboard.writeText(resultJson.value)
  } catch {
    /* 剪贴板不可用时静默 */
  }
}
</script>

<template>
  <div class="detail-result">
    <div class="head">
      <el-button
        type="primary"
        size="small"
        :loading="testing"
        :disabled="!hasFields"
        :icon="RefreshCw"
        @click="emit('test')"
      >
        测试详情规则
      </el-button>
      <el-button v-if="result" size="small" :icon="Copy" @click="copyJson">复制 JSON</el-button>
      <span v-if="result" class="summary" :class="result.ok ? 'is-ok' : 'is-bad'">{{ result.message }}</span>
    </div>

    <template v-if="result">
      <table v-if="result.fields.length > 0" class="field-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>命中</th>
            <th>状态</th>
            <th>提取值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in result.fields" :key="field.key">
            <td><code>{{ field.key }}</code></td>
            <td>{{ field.matched }}</td>
            <td>
              <span class="state" :class="field.ok ? 'is-ok' : 'is-bad'">
                <CheckCircle2 v-if="field.ok" :size="13" />
                <XCircle v-else :size="13" />
                {{ field.ok ? (field.required ? '必填通过' : '正常') : '缺失/失败' }}
              </span>
            </td>
            <td class="value">
              <template v-if="Array.isArray(field.value)">
                <div v-for="(item, index) in field.value" :key="index" class="value-item">{{ item }}</div>
              </template>
              <template v-else-if="typeof field.value === 'string'">{{ field.value }}</template>
              <template v-else-if="field.value !== null && field.value !== undefined">
                {{ JSON.stringify(field.value) }}
              </template>
              <span v-if="field.error" class="error">⚠ {{ field.error }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ result.message }}</p>
    </template>
    <p v-else class="empty">配置字段后点击「测试详情规则」，将调用真实解析引擎并显示每个字段的提取状态。</p>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.summary {
  font-size: 12px;
}

.summary.is-ok {
  color: var(--wb-success);
}

.summary.is-bad {
  color: var(--wb-danger);
}

.field-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.field-table th {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--wb-border-strong);
  color: var(--wb-text-muted);
  font-weight: 500;
}

.field-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--wb-border);
  vertical-align: top;
}

.field-table code {
  color: var(--wb-primary);
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.state.is-ok {
  color: var(--wb-success);
}

.state.is-bad {
  color: var(--wb-danger);
}

.value {
  color: var(--wb-text-secondary);
  word-break: break-all;
  max-width: 320px;
}

.value-item {
  margin-bottom: 2px;
}

.error {
  display: block;
  color: var(--wb-danger);
  margin-top: 2px;
}

.empty {
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
