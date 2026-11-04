<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Globe, MonitorPlay } from '@lucide/vue'
import type {
  CrawlRuleConfig,
  FieldCleanRule,
  FieldRule,
  PageSnapshotDto,
  PluginDto,
  TesterDetailResultDto,
  TesterListResultDto,
} from '@webcrawler/shared'
import {
  fetchSnapshot,
  testDetailRule,
  testListRule,
} from '@/api/tester'
import { listPlugins } from '@/api/plugins'
import {
  createEmptyDraft,
  loadTesterDraft,
  useTesterDraft,
  type TesterDraft,
  type TesterFieldDraft,
} from '@/composables/useTesterDraft'
import { usePanelResize } from '@/composables/usePanelResize'
import { useCommaText } from '@/composables/useCommaText'
import PreviewPane from '@/components/tester/PreviewPane.vue'
import ProxySelect from '@/components/tester/ProxySelect.vue'
import ListConfigPanel from '@/components/tester/ListConfigPanel.vue'
import FieldConfigPanel from '@/components/tester/FieldConfigPanel.vue'
import DetailResultPanel from '@/components/tester/DetailResultPanel.vue'
import ResultPanel from '@/components/tester/ResultPanel.vue'
import SavePanel from '@/components/tester/SavePanel.vue'
import {
  ARTICLE_FIELD_PRESETS,
  DETAIL_REQUIRED_FIELD_KEYS,
  LIST_REQUIRED_FIELD_KEYS,
} from '@/config/article-fields'

/* ------------------------------ 草稿即状态 ------------------------------ */


/** 模板里不能出现 `://`，统一从脚本传占位文案。 */
const LIST_URL_HINT = 'https://example.com/news'

const draft = ref<TesterDraft>(loadTesterDraft() ?? createEmptyDraft())
const { hasUnsavedChanges, flush } = useTesterDraft(draft)

/* ------------------------------ 解析器插件 ------------------------------ */

/** 解析器插件选项（type=parser 且已启用），用于详情提取后的数据重格式化 */
const parserPluginOptions = ref<PluginDto[]>([])

async function loadParserPlugins(): Promise<void> {
  try {
    const page = await listPlugins({ type: 'parser', enabled: 'true', pageSize: 100 })
    parserPluginOptions.value = page.items
  } catch {
    parserPluginOptions.value = []
  }
}

void loadParserPlugins()

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

/* ------------------------------ 排除选择器（逗号分隔输入框） ------------------------------ */

/**
 * 草稿数组 ↔ 逗号分隔文本，单向同步（打字时只往数组解析，不回写文本），
 * 否则敲 `,` 会被立即规范化掉导致输入不了逗号。
 */
const listExcludeInput = useCommaText(
  () => draft.value.list.excludeSelectors,
  (value) => {
    draft.value.list.excludeSelectors = value
  },
)

const detailExcludeInput = useCommaText(
  () => draft.value.excludeSelectors,
  (value) => {
    draft.value.excludeSelectors = value
  },
)

/** 预览测试按钮作用于当前页签的排除选择器（列表页签 → 列表排除，详情页签 → 详情排除）。 */
const activeExcludeSelectors = computed(() =>
  middleTab.value === 'list' ? draft.value.list.excludeSelectors : draft.value.excludeSelectors,
)

/* ------------------------------ 布局 ------------------------------ */

const containerRef = ref<HTMLElement | null>(null)
const { leftRatio, rightRatio, startLeftDivider, startRightDivider } = usePanelResize(containerRef)
const middleTab = ref<'list' | 'detail'>('list')

/* ------------------------------ 页面快照（按页签各自保存） ------------------------------ */

/** 列表 / 详情页签各自的页面快照与预览「去除」状态，切换页签互不影响。 */
const snapshots = reactive<{ list: PageSnapshotDto | null; detail: PageSnapshotDto | null }>({
  list: null,
  detail: null,
})
const stripState = reactive<{ list: boolean; detail: boolean }>({ list: false, detail: false })

const activeSnapshot = computed(() => snapshots[middleTab.value])

const listLoading = ref(false)

async function loadPage(): Promise<void> {
  const url = draft.value.url.trim()
  if (!url) {
    ElMessage.warning('请输入页面地址')
    return
  }
  listLoading.value = true
  try {
    const result = await fetchSnapshot({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
    })
    if (!result.ok) {
      ElMessage.error(result.message)
    }
    snapshots.list = result
    setTabResult(result, '页面快照')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败')
  } finally {
    listLoading.value = false
  }
}

/* ------------------------------ 列表测试 ------------------------------ */

const listTesting = ref(false)
const listResult = ref<TesterListResultDto | null>(null)

async function runListTest(): Promise<void> {
  const url = draft.value.url.trim()
  const itemSelector = draft.value.list.itemSelector.trim()
  if (!url || !itemSelector) return
  const listFieldRules = listFieldsToRuleFields()
  if (!listFieldRules.title || !listFieldRules.url) {
    ElMessage.warning('请先在「列表字段配置」中添加 title 和 url 字段（必填）')
    return
  }
  listTesting.value = true
  try {
    const result = await testListRule({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
      list: {
        itemSelector,
        fields: listFieldRules,
        ...(draft.value.list.excludeSelectors.length > 0
          ? { excludeSelectors: [...draft.value.list.excludeSelectors] }
          : {}),
        ...(draft.value.list.parserPlugins.length > 0
          ? { parserPlugins: [...draft.value.list.parserPlugins] }
          : {}),
      },
      ...(draft.value.list.paginationType !== 'none' ? { pagination: buildPagination() } : {}),
    })
    listResult.value = result
    setTabResult(result, '列表测试')
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
  // 从列表结果点进来时顺手加载详情页快照，左侧预览立即展示
  if (snapshots.detail?.url !== url) void loadDetailSnapshot()
}

/* ------------------------------ 详情测试 ------------------------------ */

const detailUrl = ref('')
const detailTesting = ref(false)
const detailResult = ref<TesterDetailResultDto | null>(null)
const detailLoading = ref(false)

/** 加载详情页快照（详情页签的左侧预览与「去除」基于它）。 */
async function loadDetailSnapshot(): Promise<void> {
  const url = detailUrl.value.trim()
  if (!url) {
    ElMessage.warning('请输入详情页地址')
    return
  }
  detailLoading.value = true
  try {
    const result = await fetchSnapshot({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
    })
    if (!result.ok) ElMessage.error(result.message)
    snapshots.detail = result
    setTabResult(result, '页面快照')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败')
  } finally {
    detailLoading.value = false
  }
}

const enabledFieldCount = computed(() => draft.value.fields.filter((field) => field.enabled).length)

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
    // 测试前确保详情页快照已加载，左侧预览展示的才是被测页面
    if (snapshots.detail?.url !== url) await loadDetailSnapshot()
    const result = await testDetailRule({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
      fields: fieldsToRuleFields(),
      ...(draft.value.excludeSelectors.length > 0
        ? { excludeSelectors: [...draft.value.excludeSelectors] }
        : {}),
      ...(draft.value.parserPlugins.length > 0 ? { parserPlugins: [...draft.value.parserPlugins] } : {}),
    })
    detailResult.value = result
    setTabResult(result, '详情测试')
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
    config.list = {
      itemSelector: draft.value.list.itemSelector.trim(),
      ...(Object.keys(listFieldRules).length > 0 ? { fields: listFieldRules } : {}),
      ...(draft.value.list.excludeSelectors.length > 0
        ? { excludeSelectors: [...draft.value.list.excludeSelectors] }
        : {}),
      ...(draft.value.list.parserPlugins.length > 0
        ? { parserPlugins: [...draft.value.list.parserPlugins] }
        : {}),
    }
    if (draft.value.list.paginationType !== 'none') {
      config.pagination = buildPagination()
    }
  }
  if (Object.keys(fields).length > 0) {
    config.fields = fields
  }
  if (draft.value.excludeSelectors.length > 0) {
    config.excludeSelectors = [...draft.value.excludeSelectors]
  }
  if (draft.value.parserPlugins.length > 0) {
    config.parserPlugins = [...draft.value.parserPlugins]
  }
  return config
})

function onImported(config: CrawlRuleConfig): void {
  draft.value.url = draft.value.url // 保持当前地址
  draft.value.list.itemSelector = config.list?.itemSelector ?? ''
  const importedListFields = Object.entries(config.list?.fields ?? {})
  if (importedListFields.length === 0 && (config.list?.linkSelector || config.list?.titleSelector)) {
    // 旧版选择器写法 → 转换为字段配置（url / title）
    if (config.list?.linkSelector) {
      importedListFields.push([
        'url',
        { type: 'attr', selector: config.list.linkSelector, attribute: config.list.linkAttribute ?? 'href', required: true },
      ])
    }
    if (config.list?.titleSelector) {
      importedListFields.push(['title', { type: 'text', selector: config.list.titleSelector, required: true }])
    }
  }
  // 旧版封面选择器 → 封面列表字段
  if (config.list?.coverSelector && !importedListFields.some(([key]) => key === 'cover')) {
    importedListFields.push([
      'cover',
      {
        type: 'attr',
        selector: config.list.coverSelector,
        attribute: config.list.coverAttribute ?? 'src',
      },
    ])
  }
  draft.value.list.listFields = importedListFields.map(([key, rule]) => toFieldDraft(key, rule))
  const pagination = config.pagination
  draft.value.list.paginationType = pagination?.type ?? 'none'
  draft.value.list.paginationParameter = pagination?.parameter ?? 'page'
  draft.value.list.paginationPathPattern = pagination?.pathPattern ?? '/page/{page}'
  draft.value.list.maxPages = pagination?.maxPages ?? null
  draft.value.parserPlugins = Array.isArray(config.parserPlugins)
    ? config.parserPlugins.filter((name): name is string => typeof name === 'string')
    : []
  draft.value.list.parserPlugins = Array.isArray(config.list?.parserPlugins)
    ? config.list.parserPlugins.filter((name): name is string => typeof name === 'string')
    : []
  draft.value.list.excludeSelectors = Array.isArray(config.list?.excludeSelectors)
    ? config.list.excludeSelectors.filter((name): name is string => typeof name === 'string')
    : []
  draft.value.excludeSelectors = Array.isArray(config.excludeSelectors)
    ? config.excludeSelectors.filter((name): name is string => typeof name === 'string')
    : []

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

/* ------------------------------ 右侧结果（按页签各自保存） ------------------------------ */

/** 列表 / 详情页签各自的右侧结果面板内容，切换页签互不影响。 */
const results = reactive<{ list: { payload: unknown; label: string } | null; detail: { payload: unknown; label: string } | null }>({
  list: null,
  detail: null,
})

function setTabResult(payload: unknown, label: string): void {
  results[middleTab.value] = { payload, label }
}

const activeResult = computed(() => results[middleTab.value])

const requestInfo = computed(() => {
  const snapshot = activeSnapshot.value
  if (!snapshot) return null
  return {
    url: snapshot.url,
    finalUrl: snapshot.finalUrl,
    statusCode: snapshot.statusCode,
    elapsedMs: snapshot.elapsedMs,
    mode: snapshot.mode,
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
      <el-button type="primary" :loading="listLoading" @click="loadPage">加载页面</el-button>
    </header>

    <!-- 三栏布局 -->
    <div ref="containerRef" class="columns">
      <section class="pane" :style="{ flexBasis: `${leftRatio * 100}%` }">
        <PreviewPane
          :snapshot-html="activeSnapshot?.ok ? activeSnapshot.html : ''"
          :base="activeSnapshot?.base ?? null"
          :title="activeSnapshot?.title ?? null"
          :status-code="activeSnapshot?.statusCode ?? null"
          :exclude-selectors="activeExcludeSelectors"
          :strip-active="stripState[middleTab]"
          @update:strip-active="stripState[middleTab] = $event"
        />
      </section>

      <div class="divider" @mousedown="startLeftDivider" />

      <section class="pane pane-middle">
        <el-tabs v-model="middleTab" class="middle-tabs">
          <el-tab-pane label="列表规则" name="list">
            <div class="plugin-row">
              <span class="plugin-row__label">解析器插件（列表）</span>
              <el-select
                v-model="draft.list.parserPlugins"
                multiple
                filterable
                allow-create
                default-first-option
                size="small"
                placeholder="不使用插件"
                class="plugin-row__select"
              >
                <el-option
                  v-for="plugin in parserPluginOptions"
                  :key="plugin.name"
                  :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
                  :value="plugin.name"
                />
              </el-select>
              <span class="binding-hint">仅对列表字段提取后生效，与详情互不影响</span>
            </div>
            <div class="plugin-row">
              <span class="plugin-row__label">排除选择器（列表）</span>
              <el-input
                v-model="listExcludeInput"
                size="small"
                clearable
                placeholder="如 .ad, .time（逗号分隔，可不填）"
                class="plugin-row__select"
              />
              <span class="binding-hint">优先级最高：字段提取前先删除命中的节点（混淆 / 广告），可不填</span>
            </div>
            <ListConfigPanel
              v-model:item-selector="draft.list.itemSelector"
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
              title="列表字段配置"
              subtitle="title 与 url 必填；其余内置字段与详情规则一致，自定义字段随链接入库存入 extra"
              :built-ins="ARTICLE_FIELD_PRESETS"
              :required-keys="LIST_REQUIRED_FIELD_KEYS"
            />
          </el-tab-pane>

          <el-tab-pane :label="`详情规则（${enabledFieldCount}）`" name="detail">
            <div class="plugin-row">
              <span class="plugin-row__label">解析器插件（详情）</span>
              <el-select
                v-model="draft.parserPlugins"
                multiple
                filterable
                allow-create
                default-first-option
                size="small"
                placeholder="不使用插件"
                class="plugin-row__select"
              >
                <el-option
                  v-for="plugin in parserPluginOptions"
                  :key="plugin.name"
                  :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
                  :value="plugin.name"
                />
              </el-select>
              <span class="binding-hint">仅对详情字段提取后生效，与列表互不影响</span>
            </div>
            <div class="plugin-row">
              <span class="plugin-row__label">排除选择器（详情）</span>
              <el-input
                v-model="detailExcludeInput"
                size="small"
                clearable
                placeholder="如 .ad, .author-info（逗号分隔，可不填）"
                class="plugin-row__select"
              />
              <span class="binding-hint">优先级最高：字段提取前先删除命中的节点（混淆 / 广告），可不填</span>
            </div>
            <div class="detail-url-row">
              <el-input
                v-model="detailUrl"
                size="small"
                placeholder="详情页地址（可从列表测试结果点击选择）"
                clearable
                @keyup.enter="loadDetailSnapshot"
              />
              <el-button size="small" :loading="detailLoading" @click="loadDetailSnapshot">
                加载页面
              </el-button>
            </div>
            <FieldConfigPanel
              v-model:fields="draft.fields"
              title="字段配置"
              subtitle="与列表规则共用同一套内置字段；保存后可直接被采集引擎执行"
              :built-ins="ARTICLE_FIELD_PRESETS"
              :required-keys="DETAIL_REQUIRED_FIELD_KEYS"
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
          :payload="activeResult?.payload"
          :payload-label="activeResult?.label ?? ''"
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
  flex: 1;
  min-height: 0;
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

.binding-hint {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.plugin-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.plugin-row__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text-secondary);
  white-space: nowrap;
}

.plugin-row__select {
  flex: 0 1 300px;
  min-width: 180px;
}

.detail-url-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

/*
 * 小屏幕：不允许再并排三栏，改为纵向排列并可滚动。
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
