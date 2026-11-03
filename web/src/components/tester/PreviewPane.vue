<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  isPreviewOutboundMessage,
  type PreviewOutboundMessage,
} from '@webcrawler/shared'
import { buildPreviewDocument } from '@/preview/agent-source'

const props = defineProps<{
  /** 服务端返回的已清洗快照 HTML */
  snapshotHtml: string
  /** 相对地址解析基准（最终 URL），由服务端注入 <base>，这里仅用于占位提示 */
  base: string | null
  /** 页面标题（来自服务端快照） */
  title?: string | null
  /** 响应状态码 */
  statusCode?: number | null
}>()

const emit = defineEmits<{
  ready: []
  selected: [message: Extract<PreviewOutboundMessage, { type: 'selected' }>]
  highlightResult: [message: Extract<PreviewOutboundMessage, { type: 'highlight-result' }>]
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)

const srcdoc = computed(() =>
  props.snapshotHtml ? buildPreviewDocument(props.snapshotHtml) : emptyDocument(),
)

function emptyDocument(): string {
  return '<!doctype html><html><body style="font-family:sans-serif;color:#8a94a6;display:grid;place-items:center;height:100vh;margin:0">输入地址并点击「加载页面」开始</body></html>'
}

function onMessage(event: MessageEvent): void {
  // 双重校验：消息必须来自本 iframe，且结构符合受控协议
  if (event.source !== iframeRef.value?.contentWindow) return
  if (!isPreviewOutboundMessage(event.data)) return

  if (event.data.type === 'ready') emit('ready')
  else if (event.data.type === 'selected') emit('selected', event.data)
  else if (event.data.type === 'highlight-result') emit('highlightResult', event.data)
}

/** 高亮某选择器的所有匹配（校验在 iframe 内的真实 DOM 中进行）。 */
function highlight(selector: string | null, selectorType: 'css' | 'xpath' = 'css'): void {
  iframeRef.value?.contentWindow?.postMessage(
    { source: 'webcrawler-preview', type: 'highlight', selector, selectorType },
    '*',
  )
}

/** 清除高亮与选中标记。 */
function clearMarks(): void {
  iframeRef.value?.contentWindow?.postMessage(
    { source: 'webcrawler-preview', type: 'clear' },
    '*',
  )
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

watch(
  () => props.snapshotHtml,
  () => clearMarks(),
)

defineExpose({ highlight, clearMarks })
</script>

<template>
  <div class="preview">
    <div class="preview-meta">
      <span v-if="title" class="preview-title" :title="title">{{ title }}</span>
      <span v-if="statusCode != null" class="preview-status" :class="{ 'is-bad': statusCode >= 400 }">
        HTTP {{ statusCode }}
      </span>
      <span v-if="base" class="preview-base" :title="base">基准：{{ base }}</span>
      <span v-else class="preview-base is-empty">尚未加载</span>
    </div>
    <!--
      安全隔离：
      - allow-scripts 之外全部关闭：无 same-origin（读不到后台数据）、无 top-navigation、无 popup；
      - 内容是服务端清洗后的快照，目标站点脚本不可能执行；
      - 注入脚本通过受控 postMessage 协议与父页面通信。
    -->
    <iframe
      ref="iframeRef"
      class="preview-frame"
      sandbox="allow-scripts"
      :srcdoc="srcdoc"
      title="网页预览"
    />
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}

.preview-meta {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 12px;
  color: var(--wb-text-muted);
  white-space: nowrap;
  overflow: hidden;
}

.preview-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--wb-text-secondary);
  font-weight: 500;
}

.preview-status {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-success-soft);
  color: var(--wb-success);
  font-size: 11px;
}

.preview-status.is-bad {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

.preview-base {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-base.is-empty {
  opacity: 0.6;
}

.preview-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: #fff;
}
</style>
