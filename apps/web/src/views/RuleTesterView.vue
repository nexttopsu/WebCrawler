<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Globe, MonitorPlay } from '@lucide/vue'
import type {
  CrawlRuleConfig,
  FieldCleanRule,
  FieldRule,
  PageSnapshotDto,
  PreviewOutboundMessage,
  TesterDetailResultDto,
  TesterListResultDto,
} from '@webcrawler/shared'
import {
  checkSelector as apiCheckSelector,
  fetchSnapshot,
  testDetailRule,
  testListRule,
} from '@/api/tester'
import {
  createEmptyDraft,
  loadTesterDraft,
  useTesterDraft,
  type TesterDraft,
  type TesterFieldDraft,
} from '@/composables/useTesterDraft'
import { usePanelResize } from '@/composables/usePanelResize'
import PreviewPane from '@/components/tester/PreviewPane.vue'
import ProxySelect from '@/components/tester/ProxySelect.vue'
import SelectorBar, { type SelectionInfo } from '@/components/tester/SelectorBar.vue'
import ListConfigPanel from '@/components/tester/ListConfigPanel.vue'
import FieldConfigPanel from '@/components/tester/FieldConfigPanel.vue'
import DetailResultPanel from '@/components/tester/DetailResultPanel.vue'
import ResultPanel from '@/components/tester/ResultPanel.vue'
import SavePanel from '@/components/tester/SavePanel.vue'

/* ------------------------------ 草稿即状态 ------------------------------ */


/** 模板里不能出现 `://`，统一从脚本传占位文案。 */
const LIST_URL_HINT = 'https://example.com/news'

/** 列表字段的内置预设：title / url 必填（服务端 Schema 也强制要求）。 */
const LIST_FIELD_PRESETS: Array<{
  key: string
  label: string
  type: 'text' | 'html' | 'attr'
  attribute?: string
  multiple?: boolean
  required?: boolean
}> = [
  { key: 'title', label: '标题', type: 'text', required: true },
  { key: 'url', label: '文章链接', type: 'attr', attribute: 'href', required: true },
  { key: 'cover', label: '封面图', type: 'attr', attribute: 'src' },
]
const draft = ref<TesterDraft>(loadTesterDraft() ?? createEmptyDraft())
const { hasUnsavedChanges, flush } = useTesterDraft(draft)

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value) return
  event.preventDefault()
}

onBeforeRouteLeave(() => {
  if (!hasUnsavedChanges.value) return true
  // eslint-disable-next-line no-alert
  return window.confirm('测试器有未保存的修改，确定离开吗？')
})

/* ------------------------------ 布局 ------------------------------ */

const containerRef = ref<HTMLElement | null>(null)
const { leftRatio, rightRatio, startLeftDivider, startRightDivider } = usePanelResize(containerRef)
const middleTab = ref<'list' | 'detail'>('list')

/* ------------------------------ 预览与点选 ------------------------------ */

const snapshot = ref<PageSnapshotDto | null>(null)
const loading = ref(false)
const previewRef = ref<InstanceType<typeof PreviewPane> | null>(null)

const selection = ref<SelectionInfo | null>(null)
const selector = ref('')
const matchCount = ref<number | null>(null)
const matchState = ref<'idle' | 'pending' | 'unique' | 'multi' | 'none' | 'invalid'>('idle')
const serverChecking = ref(false)

/**
 * 点选结果的绑定目标：
 * 列表页签下默认填 itemSelector；详情页签下填最后操作的字段。
 * 用户也可以点击输入框旁的「选」按钮显式指定下一个点选的落点。
 */
const bindingTarget = ref<'list.item' | 'list.link' | 'list.title' | 'list.cover' | `field:${number}`>('list.item')

async function loadPage(): Promise<void> {
  const url = draft.value.url.trim()
  if (!url) {
    ElMessage.warning('请输入页面地址')
    return
  }
  loading.value = true
  selection.value = null
  selector.value = ''
  matchState.value = 'idle'
  matchCount.value = null
  try {
    const result = await fetchSnapshot({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
    })
    if (!result.ok) {
      ElMessage.error(result.message)
    }
    snapshot.value = result
    setLastResult(result, '页面快照')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function onSelected(message: Extract<PreviewOutboundMessage, { type: 'selected' }>): void {
  selection.value = {
    tag: message.tag,
    id: message.id,
    classes: message.classes,
    path: message.path,
    outerHtml: message.outerHtml,
  }
  selector.value = message.selector
  matchCount.value = message.matchCount
  matchState.value = message.matchCount === 1 ? 'unique' : message.matchCount > 1 ? 'multi' : 'none'

  const target = bindingTarget.value
  if (target === 'list.item') draft.value.list.itemSelector = message.selector
  else if (target === 'list.link') draft.value.list.linkSelector = message.selector
  else if (target === 'list.title') draft.value.list.titleSelector = message.selector
  else if (target === 'list.cover') draft.value.list.coverSelector = message.selector
  else {
    const index = Number(target.slice('field:'.length))
    const field = draft.value.fields[index]
    if (field) field.selector = message.selector
  }
}

function onHighlightResult(message: Extract<PreviewOutboundMessage, { type: 'highlight-result' }>): void {
  matchCount.value = message.matchCount
  if (message.error) {
    matchState.value = 'invalid'
    ElMessage.warning(message.error)
    return
  }
  matchState.value = message.matchCount === 1 ? 'unique' : message.matchCount > 1 ? 'multi' : 'none'
}

/** 把当前输入框中的选择器高亮到预览里（在真实 DOM 中验证）。 */
function applySelector(): void {
  if (!selector.value.trim()) return
  matchState.value = 'pending'
  previewRef.value?.highlight(selector.value.trim())
}

/** 在服务端验证选择器（支持 XPath，预览内只支持 CSS）。 */
async function serverCheck(): Promise<void> {
  const value = selector.value.trim()
  if (!value || !draft.value.url.trim()) return
  serverChecking.value = true
  matchState.value = 'pending'
  try {
    const result = await apiCheckSelector({
      url: draft.value.url.trim(),
      selector: value,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
    })
    matchCount.value = result.matchCount
    matchState.value = !result.ok ? 'invalid' : result.unique ? 'unique' : result.exists ? 'multi' : 'none'
    ElMessage.info(result.message)
  } catch (error) {
    matchState.value = 'invalid'
    ElMessage.error(error instanceof Error ? error.message : '验证失败')
  } finally {
    serverChecking.value = false
  }
}

/* ------------------------------ 列表测试 ------------------------------ */

const listTesting = ref(false)
const listResult = ref<TesterListResultDto | null>(null)

async function runListTest(): Promise<void> {
  const url = draft.value.url.trim()
  const itemSelector = draft.value.list.itemSelector.trim()
  if (!url || !itemSelector) return
  listTesting.value = true
  try {
    const result = await testListRule({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
      list: {
        itemSelector,
        ...(Object.keys(listFieldsToRuleFields()).length > 0
          ? { fields: listFieldsToRuleFields() }
          : {}),
        ...(Object.keys(listFieldsToRuleFields()).length === 0 && draft.value.list.linkSelector.trim()
          ? { linkSelector: draft.value.list.linkSelector.trim() }
          : {}),
        ...(Object.keys(listFieldsToRuleFields()).length === 0 && draft.value.list.titleSelector.trim()
          ? { titleSelector: draft.value.list.titleSelector.trim() }
          : {}),
        ...(draft.value.list.coverSelector.trim()
          ? {
              coverSelector: draft.value.list.coverSelector.trim(),
              ...(draft.value.list.coverAttribute.trim()
                ? { coverAttribute: draft.value.list.coverAttribute.trim() }
                : {}),
            }
          : {}),
      },
      ...(draft.value.list.paginationType !== 'none' ? { pagination: buildPagination() } : {}),
    })
    listResult.value = result
    setLastResult(result, '列表测试')
    if (!result.ok) ElMessage.warning(result.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '列表测试失败')
  } finally {
    listTesting.value = false
  }
}

function buildPagination():
    | { type: 'query'; parameter: string; maxPages?: number }
    | { type: 'path'; pathPattern: string; maxPages?: number }
    | { type: 'next' }
    | { type: 'cursor'; cursorParameter?: string; maxPages?: number } {
  const { paginationType, paginationParameter, paginationPathPattern, maxPages } = draft.value.list
  if (paginationType === 'query') {
    return { type: 'query', parameter: paginationParameter || 'page', ...(maxPages ? { maxPages } : {}) }
  }
  if (paginationType === 'path') {
    return { type: 'path', pathPattern: paginationPathPattern || '/page/{page}', ...(maxPages ? { maxPages } : {}) }
  }
  if (paginationType === 'cursor') {
    return { type: 'cursor', cursorParameter: paginationParameter || 'cursor', ...(maxPages ? { maxPages } : {}) }
  }
  return { type: 'next' }
}

function pickDetail(url: string): void {
  detailUrl.value = url
  middleTab.value = 'detail'
}

/* ------------------------------ 详情测试 ------------------------------ */

const detailUrl = ref('')
const detailTesting = ref(false)
const detailResult = ref<TesterDetailResultDto | null>(null)

const enabledFieldCount = computed(() => draft.value.fields.filter((field) => field.enabled).length)

function addFieldForSelection(): void {
  bindingTarget.value = `field:${Math.max(0, draft.value.fields.length - 1)}`
  ElMessage.info('在左侧预览中点击元素，将填入最后一个字段的 Selector')
}

async function runDetailTest(): Promise<void> {
  const url = detailUrl.value.trim() || draft.value.url.trim()
  if (!url) {
    ElMessage.warning('请输入详情页地址（或从列表结果中选择一篇）')
    return
  }
  if (enabledFieldCount.value === 0) {
    ElMessage.warning('至少启用一个字段')
    return
  }
  detailTesting.value = true
  try {
    const result = await testDetailRule({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
      fields: fieldsToRuleFields(),
    })
    detailResult.value = result
    setLastResult(result, '详情测试')
    if (!result.ok) ElMessage.warning(result.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '详情测试失败')
  } finally {
    detailTesting.value = false
  }
}

/** 草稿字段 → Rule Schema 的 FieldRule（第三阶段格式，不另造格式）。 */
function draftFieldsToRuleFields(source: TesterFieldDraft[]): Record<string, FieldRule> {
  const output: Record<string, FieldRule> = {}
  for (const field of source) {
    if (!field.enabled) continue
    if (!field.selector.trim() && !field.defaultValue.trim()) continue
    const clean: FieldCleanRule = {}
    if (field.trim) clean.trim = true
    if (field.collapseWhitespace) clean.collapseWhitespace = true
    output[field.key.trim()] = {
      type: field.type,
      ...(field.selector.trim() ? { selector: field.selector.trim() } : {}),
      ...(field.type === 'attr' && field.attribute.trim() ? { attribute: field.attribute.trim() } : {}),
      ...(field.multiple ? { multiple: true } : {}),
      ...(field.required ? { required: true } : {}),
      ...(field.defaultValue.trim() ? { defaultValue: field.defaultValue } : {}),
      ...(Object.keys(clean).length > 0 ? { clean } : {}),
    }
  }
  return output
}

function fieldsToRuleFields(): Record<string, FieldRule> {
  return draftFieldsToRuleFields(draft.value.fields)
}

/** 列表字段配置 → FieldRule（title / url 必填由面板勾选「必填」表达）。 */
function listFieldsToRuleFields(): Record<string, FieldRule> {
  return draftFieldsToRuleFields(draft.value.list.listFields)
}

/* ------------------------------ 规则组装与保存 ------------------------------ */

const ruleConfig = computed<CrawlRuleConfig | null>(() => {
  const fields = fieldsToRuleFields()
  const hasList = draft.value.list.itemSelector.trim().length > 0
  if (!hasList && Object.keys(fields).length === 0) return null

  const config: CrawlRuleConfig = {
    version: 1,
    request: { mode: draft.value.mode },
  }
  if (hasList) {
    const listFieldRules = listFieldsToRuleFields()
    const useFieldConfig = Object.keys(listFieldRules).length > 0
    config.list = {
      itemSelector: draft.value.list.itemSelector.trim(),
      // 字段配置是推荐写法；配置了字段时旧版 link/title 选择器不再输出
      ...(!useFieldConfig && draft.value.list.linkSelector.trim()
        ? { linkSelector: draft.value.list.linkSelector.trim() }
        : {}),
      ...(!useFieldConfig && draft.value.list.titleSelector.trim()
        ? { titleSelector: draft.value.list.titleSelector.trim() }
        : {}),
      ...(draft.value.list.coverSelector.trim()
        ? {
            coverSelector: draft.value.list.coverSelector.trim(),
            ...(draft.value.list.coverAttribute.trim()
              ? { coverAttribute: draft.value.list.coverAttribute.trim() }
              : {}),
          }
        : {}),
      ...(useFieldConfig ? { fields: listFieldRules } : {}),
    }
    if (draft.value.list.paginationType !== 'none') {
      config.pagination = buildPagination()
    }
  }
  if (Object.keys(fields).length > 0) {
    config.fields = fields
  }
  return config
})

function onImported(config: CrawlRuleConfig): void {
  draft.value.url = draft.value.url // 保持当前地址
  draft.value.list.itemSelector = config.list?.itemSelector ?? ''
  draft.value.list.linkSelector = config.list?.linkSelector ?? ''
  draft.value.list.titleSelector = config.list?.titleSelector ?? ''
  draft.value.list.coverSelector = config.list?.coverSelector ?? ''
  draft.value.list.coverAttribute = config.list?.coverAttribute ?? ''
  draft.value.list.listFields = Object.entries(config.list?.fields ?? {}).map(([key, rule]) =>
    toFieldDraft(key, rule),
  )
  const pagination = config.pagination
  draft.value.list.paginationType = pagination?.type ?? 'none'
  draft.value.list.paginationParameter = pagination?.parameter ?? 'page'
  draft.value.list.paginationPathPattern = pagination?.pathPattern ?? '/page/{page}'
  draft.value.list.maxPages = pagination?.maxPages ?? null

  const source = config.fields ?? config.detail?.fields ?? {}
  draft.value.fields = Object.entries(source).map(([key, rule]) => toFieldDraft(key, rule))
  ElMessage.success('配置已应用到界面')
}

function toFieldDraft(key: string, rule: FieldRule): TesterFieldDraft {
  return {
    key,
    label: '',
    selector: typeof rule.selector === 'string' ? rule.selector : '',
    type: (rule.type === 'html' || rule.type === 'attr' ? rule.type : 'text') as TesterFieldDraft['type'],
    attribute: typeof rule.attribute === 'string' ? rule.attribute : '',
    multiple: rule.multiple === true,
    required: rule.required === true,
    defaultValue: typeof rule.defaultValue === 'string' ? rule.defaultValue : '',
    trim: rule.clean?.trim !== false,
    collapseWhitespace: rule.clean?.collapseWhitespace === true,
    enabled: true,
  }
}

function onSaved(): void {
  flush()
  hasUnsavedChanges.value = false
}

/* ------------------------------ 右侧结果 ------------------------------ */

const lastPayload = ref<unknown>(null)
const lastPayloadLabel = ref('')

function setLastResult(payload: unknown, label: string): void {
  lastPayload.value = payload
  lastPayloadLabel.value = label
}

const requestInfo = computed(() => {
  if (!snapshot.value) return null
  return {
    url: snapshot.value.url,
    finalUrl: snapshot.value.finalUrl,
    statusCode: snapshot.value.statusCode,
    elapsedMs: snapshot.value.elapsedMs,
    mode: snapshot.value.mode,
  }
})
</script>

<template>
  <div class="tester">
    <!-- 顶栏：标题 / 地址 / 模式 / 代理 / 加载 -->
    <header class="topbar">
      <h1 class="tester-title">规则测试器</h1>
      <el-input
        v-model="draft.url"
        class="url-input"
        size="default"
        :placeholder="LIST_URL_HINT"
        clearable
        @keyup.enter="loadPage"
      >
        <template #prefix>
          <Globe :size="14" />
        </template>
      </el-input>
      <el-radio-group v-model="draft.mode" size="default">
        <el-radio-button value="http">
          <span class="mode-label"><Globe :size="13" /> HTTP</span>
        </el-radio-button>
        <el-radio-button value="browser">
          <span class="mode-label"><MonitorPlay :size="13" /> Browser</span>
        </el-radio-button>
      </el-radio-group>
      <ProxySelect v-model="draft.proxyId" />
      <el-button type="primary" :loading="loading" @click="loadPage">加载页面</el-button>
    </header>

    <!-- 三栏布局 -->
    <div ref="containerRef" class="columns">
      <section class="pane" :style="{ flexBasis: `${leftRatio * 100}%` }">
        <PreviewPane
          ref="previewRef"
          :snapshot-html="snapshot?.ok ? snapshot.html : ''"
          :base="snapshot?.base ?? null"
          :title="snapshot?.title ?? null"
          :status-code="snapshot?.statusCode ?? null"
          @ready="() => applySelector()"
          @selected="onSelected"
          @highlight-result="onHighlightResult"
        />
        <SelectorBar
          v-model:selector="selector"
          :selection="selection"
          :match-count="matchCount"
          :match-state="matchState"
          :checking="serverChecking"
          @apply="applySelector"
          @server-check="serverCheck"
        />
      </section>

      <div class="divider" @mousedown="startLeftDivider" />

      <section class="pane pane-middle">
        <el-tabs v-model="middleTab" class="middle-tabs">
          <el-tab-pane label="列表规则" name="list">
            <div class="binding-row">
              <span class="binding-label">点击预览元素填入：</span>
              <el-radio-group v-model="bindingTarget" size="small">
                <el-radio-button value="list.item">itemSelector</el-radio-button>
                <el-radio-button value="list.link">linkSelector</el-radio-button>
                <el-radio-button value="list.title">titleSelector</el-radio-button>
                <el-radio-button value="list.cover">coverSelector</el-radio-button>
              </el-radio-group>
            </div>
            <ListConfigPanel
              v-model:item-selector="draft.list.itemSelector"
              v-model:link-selector="draft.list.linkSelector"
              v-model:title-selector="draft.list.titleSelector"
              v-model:cover-selector="draft.list.coverSelector"
              v-model:cover-attribute="draft.list.coverAttribute"
              v-model:pagination-type="draft.list.paginationType"
              v-model:pagination-parameter="draft.list.paginationParameter"
              v-model:pagination-path-pattern="draft.list.paginationPathPattern"
              v-model:max-pages="draft.list.maxPages"
              :testing="listTesting"
              :result="listResult"
              :detail-url="detailUrl"
              @test="runListTest"
              @pick-detail="pickDetail"
            />
            <FieldConfigPanel
              v-model:fields="draft.list.listFields"
              class="list-fields-panel"
              title="列表字段配置（推荐）"
              subtitle="title 与 url 必填；配置后 linkSelector / titleSelector 不再生效"
              :built-ins="LIST_FIELD_PRESETS"
            />
          </el-tab-pane>

          <el-tab-pane :label="`详情规则（${enabledFieldCount}）`" name="detail">
            <div class="detail-url-row">
              <el-input
                v-model="detailUrl"
                size="small"
                placeholder="详情页地址（可从列表测试结果点击选择）"
                clearable
              />
              <el-button size="small" @click="addFieldForSelection">选到字段</el-button>
            </div>
            <FieldConfigPanel
              v-model:fields="draft.fields"
              title="字段配置"
              subtitle="与第三阶段 Rule Schema 同构，保存后可直接被采集引擎执行"
            />
            <DetailResultPanel
              :result="detailResult"
              :testing="detailTesting"
              :has-fields="enabledFieldCount > 0"
              @test="runDetailTest"
            />
          </el-tab-pane>
        </el-tabs>
      </section>

      <div class="divider" @mousedown="startRightDivider" />

      <section class="pane" :style="{ flexBasis: `${rightRatio * 100}%` }">
        <ResultPanel
          :request="requestInfo"
          :payload="lastPayload"
          :payload-label="lastPayloadLabel"
        />
        <SavePanel :config="ruleConfig" @saved="onSaved" @imported="onImported" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.tester {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--wb-header-height));
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--wb-surface);
  border-bottom: 1px solid var(--wb-border);
  flex: 0 0 auto;
}

.tester-title {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex: 0 0 auto;
}

@media (max-width: 1180px) {
  .tester-title {
    display: none;
  }
}

.url-input {
  flex: 1;
  max-width: 560px;
}

.mode-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.proxy-select {
  width: 240px;
}

.columns {
  display: flex;
  flex: 1;
  min-height: 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-width: 220px;
  min-height: 0;
  overflow: hidden;
  background: var(--wb-surface);
}

.pane > :first-child {
  flex: 1;
  min-height: 0;
}

.pane-middle {
  flex: 1;
  padding: 0 12px;
  overflow: auto;
}

.divider {
  flex: 0 0 5px;
  cursor: col-resize;
  background: transparent;
  border-left: 1px solid var(--wb-border);
}

.divider:hover {
  background: var(--wb-primary-soft);
}

.middle-tabs {
  height: 100%;
}

.list-fields-panel {
  margin-top: 14px;
  border-top: 1px solid var(--wb-border);
  padding-top: 12px;
}

.middle-tabs :deep(.el-tabs__content) {
  overflow: auto;
}

.binding-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.binding-label {
  font-size: 12px;
  color: var(--wb-text-secondary);
  white-space: nowrap;
}

.detail-url-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

/*
 * 小屏幕：不允许再并排三栏（DOM 点选需要空间），改为纵向排列并可滚动。
 * 拖拽把手隐藏，各面板固定最小高度，避免被压成 0。
 */
@media (max-width: 1180px) {
  .tester {
    height: auto;
    min-height: calc(100vh - var(--wb-header-height));
    overflow: auto;
  }

  .topbar {
    flex-wrap: wrap;
  }

  .url-input {
    flex: 1 1 100%;
    max-width: none;
  }

  .columns {
    flex-direction: column;
    overflow: visible;
  }

  .divider {
    display: none;
  }

  .pane {
    flex: 0 0 auto !important;
    width: 100%;
    min-height: 420px;
    max-height: 70vh;
  }

  .pane-middle {
    min-height: 520px;
    max-height: none;
    padding: 0 8px;
  }
}
</style>
