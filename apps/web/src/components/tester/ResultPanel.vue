<script setup lang="ts">
import { computed, ref } from 'vue'
import { Copy } from '@lucide/vue'

const props = defineProps<{
  /** 最近一次请求的元信息（快照或测试结果里抽取） */
  request: {
    url: string
    finalUrl: string | null
    statusCode: number | null
    elapsedMs: number | null
    mode: string
  } | null
  /** 最近一次测试的完整 JSON 载荷 */
  payload: unknown
  payloadLabel: string
}>()

const activeTab = ref<'json' | 'request'>('json')
const collapsed = ref(false)

const jsonText = computed(() => (props.payload == null ? '' : JSON.stringify(props.payload, null, 2)))
const jsonSize = computed(() => (jsonText.value ? `${(jsonText.value.length / 1024).toFixed(1)} KB` : ''))

async function copyJson(): Promise<void> {
  if (!jsonText.value) return
  try {
    await navigator.clipboard.writeText(jsonText.value)
  } catch {
    /* 剪贴板不可用时静默 */
  }
}
</script>

<template>
  <div class="result-panel">
    <div class="panel-head">
      <el-tabs v-model="activeTab" class="tabs">
        <el-tab-pane label="JSON 结果" name="json" />
        <el-tab-pane label="请求信息" name="request" />
      </el-tabs>
      <div class="head-actions">
        <span v-if="jsonSize" class="size">{{ jsonSize }}</span>
        <el-button size="small" text :icon="Copy" :disabled="!jsonText" @click="copyJson">复制</el-button>
      </div>
    </div>

    <div v-if="activeTab === 'json'" class="json-view">
      <p v-if="!jsonText" class="empty">暂无结果。加载页面或执行测试后，这里显示完整 JSON（可折叠）。</p>
      <template v-else>
        <el-button size="small" text class="collapse-toggle" @click="collapsed = !collapsed">
          {{ collapsed ? '展开' : '折叠' }}
        </el-button>
        <pre v-if="!collapsed" class="json">{{ jsonText }}</pre>
        <p v-else class="empty">已折叠（{{ payloadLabel }}，{{ jsonSize }}）</p>
      </template>
    </div>

    <div v-else class="request-view">
      <template v-if="request">
        <dl>
          <dt>请求地址</dt>
          <dd>{{ request.url }}</dd>
          <dt>最终 URL</dt>
          <dd>{{ request.finalUrl ?? '—' }}</dd>
          <dt>状态码</dt>
          <dd :class="{ 'is-bad': request.statusCode && request.statusCode >= 400 }">
            {{ request.statusCode ?? '—' }}
          </dd>
          <dt>耗时</dt>
          <dd>{{ request.elapsedMs != null ? `${request.elapsedMs} ms` : '—' }}</dd>
          <dt>模式</dt>
          <dd>{{ request.mode }}</dd>
        </dl>
      </template>
      <p v-else class="empty">尚未发起请求。</p>
    </div>
  </div>
</template>

<style scoped>
.result-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--wb-border);
  padding-right: 10px;
}

.tabs {
  flex: 1;
}

.tabs :deep(.el-tabs__header) {
  margin: 0;
}

.tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.size {
  font-size: 11px;
  color: var(--wb-text-muted);
}

.json-view {
  flex: 1;
  overflow: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
}

.collapse-toggle {
  align-self: flex-end;
}

.json {
  margin: 0;
  font-size: 11px;
  line-height: 1.55;
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--wb-text-secondary);
}

.request-view {
  flex: 1;
  overflow: auto;
  padding: 12px;
}

.request-view dl {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: 12px;
}

.request-view dt {
  color: var(--wb-text-muted);
}

.request-view dd {
  margin: 0;
  word-break: break-all;
  color: var(--wb-text);
}

.request-view dd.is-bad {
  color: var(--wb-danger);
}

.empty {
  font-size: 12px;
  color: var(--wb-text-muted);
  margin: 8px 0;
}
</style>
