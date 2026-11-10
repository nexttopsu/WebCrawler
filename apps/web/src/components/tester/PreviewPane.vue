<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Check, Copy, Eraser, RotateCcw } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import { buildPreviewDocument } from '@/preview/preview-document'

const props = defineProps<{
  /** 服务端返回的已清洗快照 HTML */
  snapshotHtml: string
  /** 相对地址解析基准（最终 URL），由服务端注入 <base>，这里仅用于占位提示 */
  base: string | null
  /** 页面标题（来自服务端快照） */
  title?: string | null
  /** 响应状态码 */
  statusCode?: number | null
  /** 当前页签的排除选择器（测试按钮按此实时删节点） */
  excludeSelectors?: readonly string[]
  /** 排除测试状态（受控，由父组件按页签各自保存） */
  stripActive?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:stripActive', value: boolean): void
}>()

/** 视图模式：网页渲染 / HTML 源码 */
const viewMode = ref<'page' | 'html'>('page')

/** 浏览器端按选择器删除节点（仅用于预览测试，真实采集走服务端 stripElements）。 */
function stripElementsInBrowser(
  html: string,
  selectors: readonly string[],
): { html: string; removed: number } {
  if (!html.trim()) return { html, removed: 0 }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let removed = 0
  for (const selector of selectors) {
    const trimmed = selector.trim()
    if (!trimmed) continue
    try {
      const nodes = doc.querySelectorAll(trimmed)
      removed += nodes.length
      nodes.forEach((node) => node.remove())
    } catch {
      // 非法选择器跳过（与服务端 stripElements 行为一致）
    }
  }
  return { html: doc.documentElement.outerHTML, removed }
}

/** 排除结果：未开启时透传快照；开启后实时按选择器删除并统计命中数。 */
const stripped = computed(() => {
  if (!props.stripActive) return { html: props.snapshotHtml, removed: 0 }
  return stripElementsInBrowser(props.snapshotHtml, props.excludeSelectors ?? [])
})

const displayHtml = computed(() => stripped.value.html)
const removedCount = computed(() => stripped.value.removed)

function applyExclude(): void {
  const selectors = (props.excludeSelectors ?? []).filter((item) => item.trim())
  if (selectors.length === 0) {
    ElMessage.warning('请先在排除选择器输入框中填写 CSS 选择器（可用逗号分隔多个）')
    return
  }
  emit('update:stripActive', true)
}

function restoreExclude(): void {
  emit('update:stripActive', false)
}

const srcdoc = computed(() => buildPreviewDocument(displayHtml.value))

/** 有没有可复制的内容：空 HTML 时按钮禁用 */
const hasSource = computed(() => displayHtml.value.trim().length > 0)

/** 复制反馈：短暂把图标与文案切成「已复制」 */
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/** 复制当前视图的源码（开启排除后复制的是排除后的结果，与所见一致） */
async function copySource(): Promise<void> {
  if (!hasSource.value) return
  try {
    await navigator.clipboard.writeText(displayHtml.value)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1600)
    ElMessage.success(`已复制源码（${displayHtml.value.length.toLocaleString()} 字符）`)
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问，可在「查看 HTML」中手动选择复制')
  }
}

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
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
      <span v-if="stripActive" class="preview-strip-state">
        已排除 {{ removedCount }} 个节点（实时生效）
      </span>
      <div class="preview-actions">
        <el-button-group class="strip-group">
          <el-button
            :icon="Eraser"
            :type="stripActive ? 'primary' : ''"
            :disabled="!snapshotHtml"
            @click="applyExclude"
          >
            去除
          </el-button>
          <el-button
            :icon="RotateCcw"
            :disabled="!stripActive"
            @click="restoreExclude"
          >
            还原
          </el-button>
          <el-button
            :icon="copied ? Check : Copy"
            :disabled="!hasSource"
            :title="hasSource ? '复制当前显示的源码（已开启排除时为排除后的结果）' : '暂无内容，先加载页面'"
            @click="copySource"
          >
            复制
          </el-button>
        </el-button-group>
        <el-radio-group v-model="viewMode">
          <el-radio-button value="page">网页预览</el-radio-button>
          <el-radio-button value="html">查看 HTML</el-radio-button>
        </el-radio-group>
      </div>
    </div>
    <!--
      网页视图：安全隔离。
      - allow-scripts 之外全部关闭：无 same-origin（读不到后台数据）、无 top-navigation、无 popup；
      - 内容是服务端清洗后的快照，目标站点脚本不可能执行。
    -->
    <iframe
      v-if="viewMode === 'page'"
      class="preview-frame"
      sandbox="allow-scripts"
      :srcdoc="srcdoc"
      title="网页预览"
    />
    <!-- HTML 源码视图：开启排除后同样实时展示删除后的源码 -->
    <pre v-else class="preview-source">{{ displayHtml || '暂无内容，先加载页面' }}</pre>
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
  flex-wrap: wrap;
  gap: 6px 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 12px;
  color: var(--wb-text-muted);
}

.preview-title {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-base.is-empty {
  opacity: 0.6;
}

.preview-strip-state {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 11px;
}

.preview-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 0 0 auto;
}

.strip-group {
  margin-right: 4px;
}

.preview-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: #fff;
}

.preview-source {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: var(--wb-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-secondary);
  background: var(--wb-surface-muted);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
</style>
