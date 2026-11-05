<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, FileJson, Globe, MonitorPlay, Save } from '@lucide/vue'
import type {
  CrawlRuleConfig,
  FieldCleanRule,
  FieldRule,
  PageSnapshotDto,
  PluginDto,
  RuleDto,
  RuleRequestConfig,
  TesterDetailResultDto,
  TesterListResultDto,
} from '@webcrawler/shared'
import {
  fetchSnapshot,
  listCategories,
  testDetailRule,
  testListRule,
} from '@/api/tester'
import { getRule } from '@/api/rules'
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

const route = useRoute()
const router = useRouter()

const draft = ref<TesterDraft>(loadTesterDraft() ?? createEmptyDraft())
const { hasUnsavedChanges, flush } = useTesterDraft(draft)

/* ------------------------------ 关联规则 ------------------------------ */

/**
 * 从规则列表 / 规则弹窗跳过来时带 `?ruleId=`：载入该规则并锁定保存目标，
 * 测试满意后直接保存回同一条规则（版本 +1），不用再手选「更新哪条」。
 */
const linkedRule = ref<RuleDto | null>(null)
const linkedLoading = ref(false)

const testerTitle = computed(() => {
  if (linkedLoading.value) return '规则测试器 · 正在载入规则…'
  return linkedRule.value ? `规则测试器 · ${linkedRule.value.name} v${linkedRule.value.version}` : '规则测试器'
})

async function loadLinkedRule(): Promise<void> {
  const raw = route.query.ruleId
  const id = typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isInteger(id) || id <= 0) {
    linkedRule.value = null
    return
  }
  linkedLoading.value = true
  try {
    const detail = await getRule(id)
    linkedRule.value = detail
    onImported(detail.config)
    // 规则本身带了列表页地址就直接用；否则退到栏目配置的 listUrl，省一次手填
    const ruleListUrl = typeof detail.config?.list?.url === 'string' ? detail.config.list.url.trim() : ''
    if (ruleListUrl) {
      draft.value.url = ruleListUrl
    } else if (detail.categoryId) {
      const page = await listCategories(detail.siteId).catch(() => null)
      const category = page?.items.find((item) => item.id === detail.categoryId)
      if (category?.listUrl) draft.value.url = category.listUrl
    }
    ElMessage.success(`已载入规则「${detail.name}」v${detail.version}，可直接测试并保存`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '载入规则失败')
  } finally {
    linkedLoading.value = false
  }
}

function backToRules(): void {
  void router.push({ path: '/rules' })
}

/* ------------------------------ 插件选项 ------------------------------ */

/** 全部已启用插件：列表插件、详情插件、解析器从同一份数据里按能力过滤 */
const pluginOptions = ref<PluginDto[]>([])

async function loadPluginOptions(): Promise<void> {
  try {
    const page = await listPlugins({ enabled: 'true', pageSize: 100 })
    pluginOptions.value = page.items
  } catch {
    pluginOptions.value = []
  }
}

/** 解析器插件（用于字段后处理链） */
const parserPluginOptions = computed(() => pluginOptions.value.filter((item) => item.type === 'parser'))
/** 只导出 parseList 的解析器不能挂到详情，反之亦然——选项按阶段过滤，避免选完才发现不支持 */
const listParserPluginOptions = computed(() =>
  parserPluginOptions.value.filter((item) => (item.slots ?? []).includes('list')),
)
const detailParserPluginOptions = computed(() =>
  parserPluginOptions.value.filter((item) => (item.slots ?? []).includes('detail')),
)
/** 列表插件：type=flow 且导出了 getList */
const listPluginOptions = computed(() =>
  pluginOptions.value.filter((item) => item.type === 'flow' && (item.slots ?? []).includes('list')),
)
/** 详情插件：type=flow 且导出了 getDetail */
const detailPluginOptions = computed(() =>
  pluginOptions.value.filter((item) => item.type === 'flow' && (item.slots ?? []).includes('detail')),
)

/**
 * 读取选择器绑定的字符串。
 *
 * Element Plus 的 `clearable` 单选被清空时给的是 `undefined`（`valueOnClear` 的默认值），
 * 而草稿字段声明为 `string`——直接 `.trim()` 会抛 TypeError，把整棵渲染树带崩成白页。
 * 所有来自选择器 / 本地草稿的字符串都从这里过一道。
 */
function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 当前是否由列表 / 详情插件接管解析（接管后隐藏抽取规则与字段配置）。 */
const hasListPlugin = computed(() => trimmed(draft.value.list.plugin).length > 0)
const hasDetailPlugin = computed(() => trimmed(draft.value.detailPlugin).length > 0)

void loadPluginOptions()

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  void loadLinkedRule()
})

// 同一页面内换 ruleId（例如从历史记录/手改地址）时重新载入
watch(
  () => route.query.ruleId,
  () => {
    void loadLinkedRule()
  },
)
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

/* ------------------------------ 布局与抽屉 ------------------------------ */

const containerRef = ref<HTMLElement | null>(null)
const { leftRatio, startLeftDivider } = usePanelResize(containerRef)
const middleTab = ref<'list' | 'detail'>('list')

/** 测试结果（JSON / 请求信息）收进抽屉，按需打开，主工作区保持两栏。 */
const resultDrawer = ref(false)
/** 保存 / 校验 / 导入导出同样收进抽屉。 */
const saveDrawer = ref(false)

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
  const pluginId = trimmed(draft.value.list.plugin)
  const itemSelector = trimmed(draft.value.list.itemSelector)
  if (!url) return
  if (!pluginId && !itemSelector) {
    ElMessage.warning('请选择列表插件，或填写列表项选择器')
    return
  }
  const listFieldRules = listFieldsToRuleFields()
  if (!pluginId && (!listFieldRules.title || !listFieldRules.url)) {
    ElMessage.warning('请先在「列表字段配置」中添加 title 和 url 字段（必填）')
    return
  }
  listTesting.value = true
  try {
    const result = await testListRule({
      url,
      mode: draft.value.mode,
      ...(draft.value.proxyId ? { proxyId: draft.value.proxyId } : {}),
      list: pluginId
        ? {
            plugin: pluginId,
            ...(draft.value.list.excludeSelectors.length > 0
              ? { excludeSelectors: [...draft.value.list.excludeSelectors] }
              : {}),
          }
        : {
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
    | { type: 'query'; parameter: string }
    | { type: 'path'; pathPattern: string } {
  const { paginationType, paginationParameter, paginationPathPattern } = draft.value.list
  if (paginationType === 'path') {
    return { type: 'path', pathPattern: paginationPathPattern || '/page/{page}' }
  }
  return { type: 'query', parameter: paginationParameter || 'page' }
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

/** 详情页签标题：插件接管时不再显示字段数量。 */
const detailTabLabel = computed(() =>
  hasDetailPlugin.value ? '详情规则（插件）' : `详情规则（${enabledFieldCount.value}）`,
)

async function runDetailTest(): Promise<void> {
  const url = detailUrl.value.trim() || draft.value.url.trim()
  if (!url) {
    ElMessage.warning('请输入详情页地址（或从列表结果中选择一篇）')
    return
  }
  const pluginId = trimmed(draft.value.detailPlugin)
  if (!pluginId && enabledFieldCount.value === 0) {
    ElMessage.warning('请选择详情插件，或至少启用一个字段')
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
      ...(pluginId
        ? { plugin: pluginId }
        : {
            fields: fieldsToRuleFields(),
            ...(draft.value.parserPlugins.length > 0 ? { parserPlugins: [...draft.value.parserPlugins] } : {}),
          }),
      ...(draft.value.excludeSelectors.length > 0
        ? { excludeSelectors: [...draft.value.excludeSelectors] }
        : {}),
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

/* ------------------------------ 分页（仅已实现的方式） ------------------------------ */

/**
 * 界面只提供已实现的分页方式；`next`（下一页链接）/ `cursor`（游标）
 * 服务端第一版明确拒绝，不再在界面上露出。
 */
const PAGINATION_OPTIONS = [
  { value: 'none', label: '不翻页' },
  { value: 'query', label: '页码参数（?page=N）' },
  { value: 'path', label: '路径模板（/page/{page}）' },
] as const

function setPaginationType(value: unknown): void {
  draft.value.list.paginationType = value === 'query' || value === 'path' ? value : 'none'
}

/* ------------------------------ 规则组装与保存 ------------------------------ */

/**
 * 测试器界面没覆盖到的原始配置（request 里的 method/headers/timeout、clean、validate 等）
 * 原样带到保存结果里，避免「在测试器里保存一次就丢字段」。
 */
const configExtras = ref<Record<string, unknown>>({})
const requestExtras = ref<RuleRequestConfig>({})
const listUrlExtra = ref('')

/** 由草稿界面管理的顶层键，其余键视为「透传配置」。 */
const MANAGED_CONFIG_KEYS = new Set([
  'version',
  'request',
  'list',
  'pagination',
  'detail',
  'fields',
  'parserPlugins',
  'excludeSelectors',
  'collectScope',
])

const ruleConfig = computed<CrawlRuleConfig | null>(() => {
  const fields = fieldsToRuleFields()
  const listPlugin = trimmed(draft.value.list.plugin)
  const detailPlugin = trimmed(draft.value.detailPlugin)
  const hasList = listPlugin.length > 0 || trimmed(draft.value.list.itemSelector).length > 0
  if (!hasList && Object.keys(fields).length === 0 && !detailPlugin) return null

  const config: CrawlRuleConfig = {
    ...(configExtras.value as Partial<CrawlRuleConfig>),
    version: 1,
    request: { ...requestExtras.value, mode: draft.value.mode },
  }
  if (hasList) {
    const listFieldRules = listFieldsToRuleFields()
    config.list = listPlugin
      ? {
          plugin: listPlugin,
          ...(listUrlExtra.value ? { url: listUrlExtra.value } : {}),
          ...(draft.value.list.excludeSelectors.length > 0
            ? { excludeSelectors: [...draft.value.list.excludeSelectors] }
            : {}),
        }
      : {
          itemSelector: trimmed(draft.value.list.itemSelector),
          ...(listUrlExtra.value ? { url: listUrlExtra.value } : {}),
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
  if (detailPlugin) {
    // 详情插件接管解析，不再写字段映射
    config.detail = { plugin: detailPlugin }
  } else if (Object.keys(fields).length > 0) {
    config.fields = fields
  }
  if (!detailPlugin && draft.value.excludeSelectors.length > 0) {
    config.excludeSelectors = [...draft.value.excludeSelectors]
  }
  if (!detailPlugin && draft.value.parserPlugins.length > 0) {
    config.parserPlugins = [...draft.value.parserPlugins]
  }
  if (draft.value.collectScope === 'list') config.collectScope = 'list'
  return config
})

function onImported(config: CrawlRuleConfig): void {
  draft.value.url = draft.value.url // 保持当前地址
  // 先记下界面不覆盖的部分，保存时原样带回
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!MANAGED_CONFIG_KEYS.has(key)) extras[key] = value
  }
  configExtras.value = extras
  const { mode: _mode, ...restRequest } = config.request ?? {}
  requestExtras.value = restRequest as RuleRequestConfig
  listUrlExtra.value = typeof config.list?.url === 'string' ? config.list.url : ''
  draft.value.collectScope = config.collectScope === 'list' ? 'list' : 'full'
  draft.value.list.plugin = config.list?.plugin ?? ''
  draft.value.detailPlugin = config.detail?.plugin ?? ''
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
  const rawPaginationType = pagination?.type ?? 'none'
  if (rawPaginationType === 'next' || rawPaginationType === 'cursor') {
    // 未实现的分页方式：界面与保存校验都不支持，回退为不翻页并提示
    draft.value.list.paginationType = 'none'
    ElMessage.warning('该规则使用了未实现的分页方式（下一页链接 / 游标），已回退为不翻页')
  } else {
    draft.value.list.paginationType = rawPaginationType
  }
  draft.value.list.paginationParameter = pagination?.parameter ?? 'page'
  draft.value.list.paginationPathPattern = pagination?.pathPattern ?? '/page/{page}'
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

function onSaved(ruleId: number, rule: RuleDto): void {
  flush()
  hasUnsavedChanges.value = false
  if (linkedRule.value?.id === ruleId) linkedRule.value = rule
  saveDrawer.value = false
}

/* ------------------------------ 右侧结果（按页签各自保存） ------------------------------ */

/** 列表 / 详情页签各自的测试结果载荷，切换页签互不影响。 */
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
    <!-- 顶栏：标题 / 地址与加载 / 模式 / 代理 / 结果与保存入口 -->
    <header class="topbar">
      <el-button v-if="linkedRule" text class="back-btn" title="返回采集规则" @click="backToRules">
        <ArrowLeft :size="15" />
      </el-button>
      <h1 class="tester-title" :class="{ 'is-linked': linkedRule }">{{ testerTitle }}</h1>
      <div class="url-group">
        <el-input
          v-model="draft.url"
          :placeholder="LIST_URL_HINT"
          clearable
          @keyup.enter="loadPage"
        >
          <template #prefix>
            <Globe :size="14" />
          </template>
        </el-input>
        <el-button type="primary" :loading="listLoading" @click="loadPage">加载页面</el-button>
      </div>
      <el-radio-group v-model="draft.mode">
        <el-radio-button value="http">
          <span class="mode-label"><Globe :size="13" /> HTTP</span>
        </el-radio-button>
        <el-radio-button value="browser">
          <span class="mode-label"><MonitorPlay :size="13" /> Browser</span>
        </el-radio-button>
      </el-radio-group>
      <ProxySelect v-model="draft.proxyId" />
      <div class="topbar-actions">
        <el-badge is-dot :hidden="!activeResult" class="result-badge">
          <el-button :icon="FileJson" @click="resultDrawer = true">测试结果</el-button>
        </el-badge>
        <el-button type="primary" plain :icon="Save" @click="saveDrawer = true">保存规则</el-button>
      </div>
    </header>

    <!-- 双栏布局：左侧页面预览，右侧规则配置 -->
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

      <section class="pane pane-config">
        <div class="scope-row">
          <span class="scope-label">采集范围</span>
          <el-radio-group v-model="draft.collectScope">
            <el-radio-button value="full">列表 + 详情</el-radio-button>
            <el-radio-button value="list">仅列表</el-radio-button>
          </el-radio-group>
          <span class="scope-hint">
            {{ draft.collectScope === 'list' ? '只入库列表项（标题 + 链接），正文稍后单篇 / 批量补采' : '列表与正文一次采完' }}
          </span>
        </div>

        <el-tabs v-model="middleTab" class="config-tabs">
          <!-- 列表规则：选择器 → 字段 → 测试 → 高级 -->
          <el-tab-pane label="列表规则" name="list">
            <ListConfigPanel
              v-model:item-selector="draft.list.itemSelector"
              :plugin-mode="hasListPlugin"
              :testing="listTesting"
              :result="listResult"
              :detail-url="detailUrl"
              @test="runListTest"
              @pick-detail="pickDetail"
            >
              <FieldConfigPanel
                v-if="!hasListPlugin"
                v-model:fields="draft.list.listFields"
                class="stack-section"
                title="列表字段配置"
                subtitle="title 与 url 必填；其余内置字段与详情规则一致，自定义字段随链接入库存入 extra"
                :built-ins="ARTICLE_FIELD_PRESETS"
                :required-keys="LIST_REQUIRED_FIELD_KEYS"
              />
            </ListConfigPanel>

            <el-collapse class="advanced stack-section">
              <el-collapse-item name="list">
                <template #title>
                  <span class="advanced-title">
                    高级设置
                    <el-tag size="small" v-if="hasListPlugin" effect="plain">列表插件已启用</el-tag>
                  </span>
                </template>

                <div class="tester-field">
                  <span class="tester-field__label">列表插件</span>
                  <el-select
                    v-model="draft.list.plugin"
                    filterable
                    clearable
                    value-on-clear=""
                    placeholder="不使用插件（改用抽取规则）"
                  >
                    <el-option
                      v-for="plugin in listPluginOptions"
                      :key="plugin.pluginId"
                      :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
                      :value="plugin.pluginId"
                    />
                  </el-select>
                  <p class="tester-field__hint">
                    全流程插件：传入分页后的完整地址，直接返回文章列表；选中后无需抽取规则与字段配置。
                  </p>
                </div>

                <div class="tester-field">
                  <span class="tester-field__label">解析器插件（列表）</span>
                  <el-select
                    v-model="draft.list.parserPlugins"
                    multiple
                    filterable
                    allow-create
                    default-first-option
                    placeholder="不使用插件"
                  >
                    <el-option
                      v-for="plugin in listParserPluginOptions"
                      :key="plugin.pluginId"
                      :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
                      :value="plugin.pluginId"
                    />
                  </el-select>
                  <p class="tester-field__hint">仅对列表字段提取后生效，与详情互不影响。</p>
                </div>

                <div class="tester-field">
                  <span class="tester-field__label">排除选择器（列表）</span>
                  <el-input
                    v-model="listExcludeInput"
                    clearable
                    placeholder="如 .ad, .time（逗号分隔，可不填）"
                  />
                  <p class="tester-field__hint">优先级最高：字段提取前先删除命中的节点（混淆 / 广告），可不填。</p>
                </div>

                <div class="tester-field">
                  <span class="tester-field__label">分页方式</span>
                  <div class="pagination-row">
                    <el-select
                      class="pg-type"
                      :model-value="draft.list.paginationType"
                      @update:model-value="setPaginationType"
                    >
                      <el-option
                        v-for="item in PAGINATION_OPTIONS"
                        :key="item.value"
                        :value="item.value"
                        :label="item.label"
                      />
                    </el-select>
                    <el-input
                      v-if="draft.list.paginationType === 'query'"
                      v-model="draft.list.paginationParameter"
                      class="pg-field"
                      placeholder="参数名，如 page"
                    />
                    <el-input
                      v-else-if="draft.list.paginationType === 'path'"
                      v-model="draft.list.paginationPathPattern"
                      class="pg-field"
                      placeholder="/page/{page}"
                    />
                  </div>
                  <p class="tester-field__hint">
                    测试时只抓取当前页；抓取页数范围由采集任务的「开始分页 / 结束分页」控制。
                  </p>
                </div>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>

          <!-- 详情规则：地址 → 字段 → 测试 → 高级 -->
          <el-tab-pane :label="detailTabLabel" name="detail">
            <div class="tester-field">
              <span class="tester-field__label">详情页地址</span>
              <div class="detail-url-row">
                <el-input
                  v-model="detailUrl"
                  placeholder="从列表测试结果点击选择，或直接粘贴地址"
                  clearable
                  @keyup.enter="loadDetailSnapshot"
                />
                <el-button :loading="detailLoading" @click="loadDetailSnapshot">加载页面</el-button>
              </div>
              <p class="tester-field__hint">点击列表测试结果中的任一条链接，会自动填入并加载该详情页。</p>
            </div>

            <FieldConfigPanel
              v-if="!hasDetailPlugin"
              v-model:fields="draft.fields"
              class="stack-section"
              title="字段配置"
              subtitle="与列表规则共用同一套内置字段；保存后可直接被采集引擎执行"
              :built-ins="ARTICLE_FIELD_PRESETS"
              :required-keys="DETAIL_REQUIRED_FIELD_KEYS"
            />

            <DetailResultPanel
              :result="detailResult"
              :testing="detailTesting"
              :has-fields="enabledFieldCount > 0"
              :plugin-mode="hasDetailPlugin"
              class="stack-section"
              @test="runDetailTest"
            />

            <el-collapse class="advanced stack-section">
              <el-collapse-item name="detail">
                <template #title>
                  <span class="advanced-title">
                    高级设置
                    <el-tag size="small" v-if="hasDetailPlugin" effect="plain">详情插件已启用</el-tag>
                  </span>
                </template>

                <div class="tester-field">
                  <span class="tester-field__label">详情插件</span>
                  <el-select
                    v-model="draft.detailPlugin"
                    filterable
                    clearable
                    value-on-clear=""
                    placeholder="不使用插件（改用字段规则）"
                  >
                    <el-option
                      v-for="plugin in detailPluginOptions"
                      :key="plugin.pluginId"
                      :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
                      :value="plugin.pluginId"
                    />
                  </el-select>
                  <p class="tester-field__hint">
                    全流程插件：传入详情页地址，直接返回文章数据对象；选中后无需字段配置。
                  </p>
                </div>

                <div class="tester-field">
                  <span class="tester-field__label">解析器插件（详情）</span>
                  <el-select
                    v-model="draft.parserPlugins"
                    multiple
                    filterable
                    allow-create
                    default-first-option
                    placeholder="不使用插件"
                  >
                    <el-option
                      v-for="plugin in detailParserPluginOptions"
                      :key="plugin.pluginId"
                      :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
                      :value="plugin.pluginId"
                    />
                  </el-select>
                  <p class="tester-field__hint">仅对详情字段提取后生效，与列表互不影响。</p>
                </div>

                <div class="tester-field">
                  <span class="tester-field__label">排除选择器（详情）</span>
                  <el-input
                    v-model="detailExcludeInput"
                    clearable
                    placeholder="如 .ad, .author-info（逗号分隔，可不填）"
                  />
                  <p class="tester-field__hint">优先级最高：字段提取前先删除命中的节点（混淆 / 广告），可不填。</p>
                </div>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>

    <!-- 测试结果抽屉：JSON 结果 / 请求信息 -->
    <el-drawer v-model="resultDrawer" title="测试结果" size="540px" class="result-drawer">
      <ResultPanel
        :request="requestInfo"
        :payload="activeResult?.payload"
        :payload-label="activeResult?.label ?? ''"
      />
    </el-drawer>

    <!-- 保存规则抽屉：站点 / 名称 / 校验 / 导入导出 -->
    <el-drawer v-model="saveDrawer" title="保存规则" size="480px" class="save-drawer">
      <SavePanel :config="ruleConfig" :rule="linkedRule" @saved="onSaved" @imported="onImported" />
    </el-drawer>
  </div>
</template>

<style scoped>
.tester {
  display: flex;
  flex-direction: column;
  /* 布局容器上下各有内边距，只减 --wb-header-height 会让页面多出 20px 滚动 */
  --tester-gap: 52px;
  height: calc(100vh - var(--wb-header-height) - var(--tester-gap));
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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

.tester-title.is-linked {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.back-btn {
  flex: 0 0 auto;
  padding: 0 6px;
}

/* 地址输入 + 加载按钮成组，占满中间弹性空间 */
.url-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 340px;
  min-width: 280px;
}

.url-group .el-input {
  flex: 1;
  min-width: 180px;
}

.mode-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
}

.columns {
  display: flex;
  flex: 1;
  min-height: 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-width: 240px;
  min-height: 0;
  overflow: hidden;
  background: var(--wb-surface);
}

.pane > :first-child {
  flex: 1;
  min-height: 0;
}

.pane-config {
  flex: 1;
  padding: 0 14px;
  overflow: hidden;
}

/* 配置栏第一个子元素是采集范围行，不参与「填满剩余高度」 */
.pane-config > .scope-row {
  flex: 0 0 auto;
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

.scope-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 0 2px;
}

.scope-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text-secondary);
  white-space: nowrap;
}

.scope-hint {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.config-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/*
 * 页签内容滚动：Element Plus 给 .el-tabs__content 默认加了 overflow: hidden，
 * 内容过长会被直接裁掉，这里改回可滚动（页签头与采集范围行保持固定）。
 */
.config-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* 分节：字段面板 / 结果面板 / 高级设置之间统一留白 + 分隔线 */
.stack-section {
  margin-top: 16px;
  border-top: 1px solid var(--wb-border);
  padding-top: 12px;
}

.advanced :deep(.el-collapse-item__header) {
  height: 34px;
  line-height: 34px;
  font-size: 12.5px;
}

.advanced :deep(.el-collapse-item__content) {
  padding-bottom: 14px;
}

.advanced-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--wb-text-secondary);
}

.detail-url-row {
  display: flex;
  gap: 8px;
}

.detail-url-row .el-input {
  flex: 1;
  min-width: 0;
}

.pagination-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.pg-type {
  width: 210px;
}

.pg-field {
  flex: 1;
  min-width: 150px;
}

/* 抽屉：结果面板撑满、保存面板随内容滚动 */
.result-drawer :deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.result-drawer :deep(.result-panel) {
  flex: 1;
  min-height: 0;
}

.save-drawer :deep(.el-drawer__body) {
  padding: 16px;
  overflow: auto;
}

/*
 * 小屏幕：不再并排双栏，改为纵向排列并可滚动。
 * 拖拽把手隐藏，各面板固定最小高度，避免被压成 0。
 */
@media (max-width: 1180px) {
  .tester {
    height: auto;
    min-height: calc(100vh - var(--wb-header-height) - var(--tester-gap));
    overflow: auto;
  }

  .url-group {
    flex: 1 1 100%;
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

  .pane-config {
    min-height: 520px;
    max-height: none;
    padding: 0 8px;
  }
}
</style>
