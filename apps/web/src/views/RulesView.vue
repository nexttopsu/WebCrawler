<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import {
  Braces,
  Copy,
  Download,
  Ellipsis,
  FlaskConical,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Upload,
} from '@lucide/vue'
import type { CategoryDto, CrawlRuleStatus, PluginDto, RuleDto, RuleVersionDto, SiteDto } from '@webcrawler/shared'
import { useCommaText } from '@/composables/useCommaText'
import {
  createRule,
  deleteRule,
  getRule,
  getRuleVersion,
  listRuleVersions,
  listRules,
  patchRule,
  setRuleStatus,
  validateRuleConfig,
} from '@/api/rules'
import { listPlugins } from '@/api/plugins'
import { listSites } from '@/api/sites'
import { listCategories } from '@/api/categories'
import { ApiClientError, errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import JsonViewer from '@/components/common/JsonViewer.vue'

const router = useRouter()

const list = useListQuery<RuleDto, { keyword: string; siteId?: number; status: string }>(
  (params) =>
    listRules({
      ...params,
      siteId: params.siteId || undefined,
      status: (params.status || undefined) as CrawlRuleStatus | undefined,
    }),
  { keyword: '', siteId: undefined, status: '' },
)

const siteOptions = ref<SiteDto[]>([])
const categoryOptions = ref<CategoryDto[]>([])
const siteName = computed(() => new Map(siteOptions.value.map((site) => [site.id, site.name])))
const categoryName = computed(() => new Map(categoryOptions.value.map((item) => [item.id, item.name])))

async function loadSites(): Promise<void> {
  try {
    const page = await listSites({ pageSize: 100 })
    siteOptions.value = page.items
  } catch {
    siteOptions.value = []
  }
}

async function loadCategories(siteId: number | null | undefined): Promise<void> {
  if (!siteId) {
    categoryOptions.value = []
    return
  }
  try {
    const page = await listCategories({ siteId, pageSize: 100 })
    categoryOptions.value = page.items
  } catch {
    categoryOptions.value = []
  }
}

/* ------------------------------- 结构化表单 ------------------------------- */

const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const configText = ref('')
const validating = ref(false)
const validationErrors = ref<Array<{ path: string; message: string }>>([])

const form = reactive({
  siteId: null as number | null,
  categoryId: null as number | null,
  name: '',
  description: '',
  /** 详情阶段解析器插件链（写入 config.parserPlugins） */
  parserPlugins: [] as string[],
  /** 列表阶段解析器插件链（写入 config.list.parserPlugins） */
  listParserPlugins: [] as string[],
  /** 详情阶段排除选择器（写入 config.excludeSelectors） */
  excludeSelectors: [] as string[],
  /** 列表阶段排除选择器（写入 config.list.excludeSelectors） */
  listExcludeSelectors: [] as string[],
})

/** 解析器插件选项（type=parser 且已启用） */
const parserPluginOptions = ref<PluginDto[]>([])

/**
 * 排除选择器：数组 ↔ 逗号分隔单行输入，单向同步（打字时只往数组解析，
 * 不回写文本），否则敲 `,` 会被立即规范化掉导致输入不了逗号。
 */
const listExcludeText = useCommaText(
  () => form.listExcludeSelectors,
  (value) => {
    form.listExcludeSelectors = value
  },
)

const detailExcludeText = useCommaText(
  () => form.excludeSelectors,
  (value) => {
    form.excludeSelectors = value
  },
)

async function loadParserPlugins(): Promise<void> {
  try {
    const page = await listPlugins({ type: 'parser', enabled: 'true', pageSize: 100 })
    parserPluginOptions.value = page.items
  } catch {
    parserPluginOptions.value = []
  }
}

/**
 * 把表单里的插件与排除选择器写进规则 JSON：
 * 列表项进 config.list.*，详情项进 config 顶层；仅在非空时写入对应键。
 */
function mergeParserPlugins(config: Record<string, unknown>): Record<string, unknown> {
  const listConfig = config.list as Record<string, unknown> | undefined
  const listPatch: Record<string, unknown> = {}
  if (form.listExcludeSelectors.length > 0) listPatch.excludeSelectors = [...form.listExcludeSelectors]
  if (form.listParserPlugins.length > 0) listPatch.parserPlugins = [...form.listParserPlugins]
  if (Object.keys(listPatch).length > 0) config.list = { ...(listConfig ?? {}), ...listPatch }
  if (form.excludeSelectors.length > 0) config.excludeSelectors = [...form.excludeSelectors]
  if (form.parserPlugins.length > 0) config.parserPlugins = [...form.parserPlugins]
  return config
}

const DEFAULT_CONFIG = {
  version: 1,
  request: { mode: 'http', method: 'GET', timeoutMs: 15000 },
  list: {
    itemSelector: '.news-item',
    fields: {
      title: { type: 'text', selector: '.title', required: true },
      url: { type: 'attr', selector: 'a', attribute: 'href', required: true },
    },
    pagination: { type: 'none' },
  },
  fields: {
    content: { type: 'html', selector: '.article-content', required: true },
  },
}

const formRules: FormRules = {
  siteId: [{ required: true, message: '请选择所属网站', trigger: 'change' }],
  name: [{ required: true, message: '请填写规则名称', trigger: 'blur' }],
}

const dialogTitle = computed(() => (editingId.value ? `编辑规则 #${editingId.value}` : '新建采集规则'))

function formatConfig(): void {
  try {
    configText.value = JSON.stringify(JSON.parse(configText.value), null, 2)
  } catch {
    ElMessage.warning('当前内容不是合法 JSON，无法格式化')
  }
}

async function validateConfig(): Promise<void> {
  validating.value = true
  validationErrors.value = []
  try {
    const json = JSON.parse(configText.value)
    const result = await validateRuleConfig(json)
    if (result.valid) ElMessage.success('规则通过 Schema 校验')
    else validationErrors.value = result.issues ?? []
  } catch (error) {
    if (error instanceof SyntaxError) {
      validationErrors.value = [{ path: 'JSON', message: error.message }]
    } else {
      ElMessage.error(errorMessage(error))
    }
  } finally {
    validating.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    siteId: list.filters.siteId ?? null,
    categoryId: null,
    name: '',
    description: '',
    parserPlugins: [],
    listParserPlugins: [],
    excludeSelectors: [],
    listExcludeSelectors: [],
  })
  configText.value = JSON.stringify(DEFAULT_CONFIG, null, 2)
  validationErrors.value = []
  if (form.siteId) void loadCategories(form.siteId)
  void loadParserPlugins()
  dialogVisible.value = true
}

async function openEdit(row: RuleDto): Promise<void> {
  editingId.value = row.id
  Object.assign(form, {
    siteId: row.siteId,
    categoryId: row.categoryId,
    name: row.name,
    description: row.description ?? '',
    parserPlugins: [],
    listParserPlugins: [],
    excludeSelectors: [],
    listExcludeSelectors: [],
  })
  dialogVisible.value = true
  void loadCategories(row.siteId)
  void loadParserPlugins()
  try {
    const detail = await getRule(row.id)
    configText.value = JSON.stringify(detail.config, null, 2)
    form.parserPlugins = Array.isArray(detail.config?.parserPlugins)
      ? detail.config.parserPlugins.filter((name): name is string => typeof name === 'string')
      : []
    form.listParserPlugins = Array.isArray(detail.config?.list?.parserPlugins)
      ? detail.config.list.parserPlugins.filter((name): name is string => typeof name === 'string')
      : []
    form.excludeSelectors = Array.isArray(detail.config?.excludeSelectors)
      ? detail.config.excludeSelectors.filter((name): name is string => typeof name === 'string')
      : []
    form.listExcludeSelectors = Array.isArray(detail.config?.list?.excludeSelectors)
      ? detail.config.list.excludeSelectors.filter((name): name is string => typeof name === 'string')
      : []
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || !form.siteId) return

  let config: Record<string, unknown>
  try {
    config = mergeParserPlugins(JSON.parse(configText.value) as Record<string, unknown>)
  } catch (error) {
    ElMessage.error(`规则不是合法 JSON：${(error as Error).message}`)
    return
  }

  submitting.value = true
  try {
    if (editingId.value) {
      await patchRule(editingId.value, { name: form.name.trim(), config, description: form.description.trim() || null })
      ElMessage.success('规则已更新（版本号会 +1）')
    } else {
      await createRule({
        siteId: form.siteId,
        categoryId: form.categoryId,
        name: form.name.trim(),
        config,
        description: form.description.trim() || null,
      })
      ElMessage.success('规则已创建')
    }
    dialogVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

/* --------------------------------- 复制 ---------------------------------- */

async function duplicate(row: RuleDto): Promise<void> {
  try {
    const detail = await getRule(row.id)
    await createRule({
      siteId: detail.siteId,
      categoryId: detail.categoryId,
      name: `${detail.name} 副本`.slice(0, 50),
      config: detail.config,
      description: detail.description,
    })
    ElMessage.success('已复制为新规则')
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

/* ----------------------------- 导入 / 导出 ------------------------------ */

const fileInput = ref<HTMLInputElement | null>(null)

function exportRule(row: RuleDto): void {
  const blob = new Blob([JSON.stringify(row.config, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${row.name}-v${row.version}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return

  try {
    const text = await file.text()
    const json = JSON.parse(text)
    const result = await validateRuleConfig(json)
    if (!result.valid) {
      ElMessage.error(`导入失败：${result.issues?.[0]?.path ?? ''} ${result.issues?.[0]?.message ?? '规则不合法'}`)
      return
    }
    openCreate()
    configText.value = JSON.stringify(json, null, 2)
    const imported = json as Record<string, unknown>
    form.parserPlugins = Array.isArray(imported.parserPlugins)
      ? (imported.parserPlugins as unknown[]).filter((name): name is string => typeof name === 'string')
      : []
    const importedList = imported.list as Record<string, unknown> | undefined
    form.listParserPlugins = Array.isArray(importedList?.parserPlugins)
      ? (importedList!.parserPlugins as unknown[]).filter((name): name is string => typeof name === 'string')
      : []
    form.excludeSelectors = Array.isArray(imported.excludeSelectors)
      ? (imported.excludeSelectors as unknown[]).filter((name): name is string => typeof name === 'string')
      : []
    form.listExcludeSelectors = Array.isArray(importedList?.excludeSelectors)
      ? (importedList!.excludeSelectors as unknown[]).filter((name): name is string => typeof name === 'string')
      : []
    ElMessage.success('已导入到编辑器，确认网站与名称后保存')
  } catch (error) {
    ElMessage.error(`文件不是合法 JSON：${errorMessage(error)}`)
  }
}

/* ------------------------------- 版本历史 ------------------------------- */

const versionVisible = ref(false)
const versionLoading = ref(false)
const versionRule = ref<RuleDto | null>(null)
const versions = ref<RuleVersionDto[]>([])
const versionDetail = ref<unknown>(null)
const activeVersion = ref<number | null>(null)

async function openVersions(row: RuleDto): Promise<void> {
  versionRule.value = row
  versionVisible.value = true
  versionLoading.value = true
  versionDetail.value = null
  activeVersion.value = null
  try {
    const result = await listRuleVersions(row.id)
    versions.value = result.items
    if (result.items.length > 0) await selectVersion(result.items[0]!.version)
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    versionLoading.value = false
  }
}

async function selectVersion(version: number): Promise<void> {
  if (!versionRule.value) return
  activeVersion.value = version
  try {
    const detail = await getRuleVersion(versionRule.value.id, version)
    versionDetail.value = detail.config
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

/* -------------------------------- 状态 / 删除 -------------------------------- */

async function toggleStatus(row: RuleDto): Promise<void> {
  try {
    await setRuleStatus(row.id, row.status === 'enabled' ? 'disabled' : 'enabled')
    ElMessage.success(row.status === 'enabled' ? '已停用' : '已启用')
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

const deleteVisible = ref(false)
const deleteTarget = ref<RuleDto | null>(null)
const deleteLoading = ref(false)
const deleteBlocked = ref<string | null>(null)

function askDelete(row: RuleDto): void {
  deleteTarget.value = row
  deleteBlocked.value = null
  deleteVisible.value = true
}

async function confirmDelete(force = false): Promise<void> {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await deleteRule(deleteTarget.value.id, force)
    ElMessage.success('规则已删除')
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'CONFLICT') deleteBlocked.value = error.message
    else ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

function openTester(row: RuleDto): void {
  router.push({ path: '/tester', query: { siteId: String(row.siteId), ruleId: String(row.id) } })
}

/** 列表字段数量（新版字段化写法） */
function listFieldCount(row: RuleDto): number {
  return Object.keys(row.config?.list?.fields ?? {}).length
}

/** 解析器插件数量描述：列表 N / 详情 M（只显示配置过的阶段） */
function parserPluginCount(row: RuleDto): string {
  const listCount = Array.isArray(row.config?.list?.parserPlugins) ? row.config.list.parserPlugins.length : 0
  const detailCount = Array.isArray(row.config?.parserPlugins) ? row.config.parserPlugins.length : 0
  const parts: string[] = []
  if (listCount > 0) parts.push(`列表 ${listCount}`)
  if (detailCount > 0) parts.push(`详情 ${detailCount}`)
  return parts.join(' / ')
}

void loadSites()
</script>

<template>
  <div class="view">
    <PageHeader title="采集规则" description="规则是可校验的 JSON：列表项、字段映射与分页策略。每次保存都会生成新版本。">
      <template #actions>
        <el-button @click="triggerImport">
          <Upload :size="14" />
          <span>导入 JSON</span>
        </el-button>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          <span>新建规则</span>
        </el-button>
      </template>
    </PageHeader>

    <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFileChange" />

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索规则名称" @search="list.search()" />
      <el-select v-model="list.filters.siteId" placeholder="全部网站" clearable filterable style="width: 190px" @change="list.search()">
        <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
      </el-select>
      <el-select v-model="list.filters.status" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="启用" value="enabled" />
        <el-option label="停用" value="disabled" />
      </el-select>
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      empty-title="还没有采集规则"
      empty-description="规则可以挂在站点下（作为默认），也可以绑定到具体栏目"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="规则" min-width="200">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-title">{{ row.name }}</span>
            <span class="wb-muted cell-sub">
              {{ siteName.get(row.siteId) ?? `站点 #${row.siteId}` }}
              <template v-if="row.categoryId"> · 栏目 {{ categoryName.get(row.categoryId) ?? `#${row.categoryId}` }}</template>
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="版本" width="90">
        <template #default="{ row }">
          <span class="wb-tag wb-tag--primary">v{{ row.version }}</span>
        </template>
      </el-table-column>

      <el-table-column label="列表配置" min-width="200">
        <template #default="{ row }">
          <div class="list-config-cell">
            <code class="wb-mono selectors">{{ row.config?.list?.itemSelector ?? '—' }}</code>
            <span class="wb-muted cell-sub">
              <template v-if="listFieldCount(row) > 0">{{ listFieldCount(row) }} 个列表字段</template>
              <template v-else>旧版选择器写法</template>
              <template v-if="parserPluginCount(row)"> · 解析器插件 {{ parserPluginCount(row) }}</template>
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <StatusTag :status="row.status" />
        </template>
      </el-table-column>

      <el-table-column label="更新时间" width="160">
        <template #default="{ row }">
          <span class="wb-muted">{{ new Date(row.updatedAt).toLocaleString('zh-CN') }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text @click="openTester(row)">
              <FlaskConical :size="13" />
              测试
            </el-button>
            <el-button size="small" text @click="openVersions(row)">
              <History :size="13" />
              版本
            </el-button>
            <el-button size="small" text @click="openEdit(row)">
              <Pencil :size="13" />
              编辑
            </el-button>
            <el-dropdown trigger="click">
              <el-button size="small" text title="更多操作">
                <Ellipsis :size="15" />
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="duplicate(row)">
                    <Copy :size="13" />
                    <span>复制规则</span>
                  </el-dropdown-item>
                  <el-dropdown-item @click="exportRule(row)">
                    <Download :size="13" />
                    <span>导出 JSON</span>
                  </el-dropdown-item>
                  <el-dropdown-item divided @click="toggleStatus(row)">
                    {{ row.status === 'enabled' ? '停用规则' : '启用规则' }}
                  </el-dropdown-item>
                  <el-dropdown-item divided @click="askDelete(row)">
                    <span class="danger-text">删除规则</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openCreate">新建规则</el-button>
      </template>
    </DataTable>

    <FormDialog
      v-model="dialogVisible"
      :title="dialogTitle"
      :loading="submitting"
      :width="760"
      submit-text="保存规则"
      description="配置必须通过 Rule Schema 校验才能保存；保存后版本号自动 +1。"
      @submit="submit"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="90px" class="rule-form">
        <div class="form-grid">
          <el-form-item label="所属网站" prop="siteId">
            <el-select v-model="form.siteId" filterable placeholder="选择网站" style="width: 100%" @change="loadCategories(form.siteId)">
              <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="绑定栏目">
            <el-select v-model="form.categoryId" clearable placeholder="站点级（作为默认规则）" style="width: 100%">
              <el-option v-for="category in categoryOptions" :key="category.id" :label="category.name" :value="category.id" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="规则名称" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="例如：新闻列表默认规则" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" maxlength="200" placeholder="可选" />
        </el-form-item>
        <el-form-item label="列表插件">
          <el-select
            v-model="form.listParserPlugins"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="不使用（列表字段提取后直接使用）"
            style="width: 100%"
          >
            <el-option
              v-for="plugin in parserPluginOptions"
              :key="plugin.name"
              :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
              :value="plugin.name"
            />
          </el-select>
          <p class="plugin-hint">列表字段提取后按顺序重格式化（如图片解密）；写入 list.parserPlugins，与详情互不影响。</p>
        </el-form-item>
        <el-form-item label="详情插件">
          <el-select
            v-model="form.parserPlugins"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="不使用（详情字段提取后直接清洗入库）"
            style="width: 100%"
          >
            <el-option
              v-for="plugin in parserPluginOptions"
              :key="plugin.name"
              :label="`${plugin.name}${plugin.description ? ` · ${plugin.description}` : ''}`"
              :value="plugin.name"
            />
          </el-select>
          <p class="plugin-hint">详情字段提取后按顺序重格式化（如图片解密）；写入 parserPlugins，与列表互不影响。</p>
        </el-form-item>
        <el-form-item label="列表排除">
          <el-input
            v-model="listExcludeText"
            clearable
            placeholder="如 .ad, .time（逗号分隔，可不填）"
          />
          <p class="plugin-hint">优先级最高：列表字段提取前先删除命中的节点（混淆 / 广告）；写入 list.excludeSelectors，可不填。</p>
        </el-form-item>
        <el-form-item label="详情排除">
          <el-input
            v-model="detailExcludeText"
            clearable
            placeholder="如 .ad, .author-info（逗号分隔，可不填）"
          />
          <p class="plugin-hint">优先级最高：详情字段提取前先删除命中的节点（混淆 / 广告）；写入 excludeSelectors，可不填。</p>
        </el-form-item>
        <el-form-item label="规则 JSON">
          <div class="json-editor">
            <div class="json-editor__bar">
              <span class="json-editor__label">
                <Braces :size="14" />
                JSON 配置
              </span>
              <div class="json-editor__actions">
                <el-button @click="formatConfig">
                  <Braces :size="14" />
                  <span>格式化</span>
                </el-button>
                <el-button type="primary" plain :loading="validating" @click="validateConfig">
                  <span>Schema 校验</span>
                </el-button>
              </div>
            </div>
            <el-input v-model="configText" type="textarea" :rows="16" class="wb-mono" spellcheck="false" />
            <ul v-if="validationErrors.length" class="json-errors">
              <li v-for="(issue, index) in validationErrors" :key="index">
                <code>{{ issue.path || 'root' }}</code>
                {{ issue.message }}
              </li>
            </ul>
          </div>
        </el-form-item>
      </el-form>
    </FormDialog>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除规则"
      :danger="true"
      :loading="deleteLoading"
      :confirm-text="deleteBlocked ? '解除引用并删除' : '删除'"
      @confirm="confirmDelete(Boolean(deleteBlocked))"
    >
      <p class="wb-secondary">{{ deleteTarget?.name }}（v{{ deleteTarget?.version }}）</p>
      <p v-if="deleteBlocked" class="delete-blocked">{{ deleteBlocked }}</p>
      <p v-else class="wb-secondary">历史版本快照会一并删除。</p>
    </ConfirmDialog>

    <el-drawer v-model="versionVisible" title="规则版本" size="620px" append-to-body>
      <div v-loading="versionLoading" class="version-panel">
        <el-timeline v-if="versions.length">
          <el-timeline-item
            v-for="item in versions"
            :key="item.version"
            :timestamp="new Date(item.createdAt).toLocaleString('zh-CN')"
            placement="top"
          >
            <button
              type="button"
              class="version-item"
              :class="{ 'is-active': activeVersion === item.version }"
              @click="selectVersion(item.version)"
            >
              <span class="wb-tag wb-tag--primary">v{{ item.version }}</span>
              <span class="wb-muted">{{ item.note ?? '配置更新' }}</span>
            </button>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="没有版本记录" :image-size="80" />

        <JsonViewer v-if="versionDetail" :value="versionDetail" :max-height="380" />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.cell-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-title {
  font-weight: 500;
}

.cell-sub {
  font-size: 11.5px;
}

.selectors {
  color: var(--wb-text-secondary);
  word-break: break-all;
}

.list-config-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.plugin-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
  line-height: 1.5;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: nowrap;
}

.row-actions :deep(.el-button span) {
  white-space: nowrap;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}

/* ---- 控件高度统一：按钮 / 输入框 / 选择框均为 32px ----
   页头与筛选栏在 .view 下；表单弹窗 append-to-body，样式挂在 .rule-form 自身。 */
.view :deep(.page-header .el-button),
.view :deep(.filter-bar .el-button) {
  height: 32px;
}

.view :deep(.filter-bar .el-input__wrapper) {
  height: 32px;
}

.view :deep(.filter-bar .el-select__wrapper) {
  min-height: 32px;
}

.rule-form :deep(.el-form-item .el-button) {
  height: 32px;
}

.rule-form :deep(.el-form-item .el-input__wrapper) {
  height: 32px;
}

.rule-form :deep(.el-form-item .el-select__wrapper) {
  min-height: 32px;
}

/* ------------------------------- JSON 编辑器 ------------------------------ */

.json-editor {
  width: 100%;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  overflow: hidden;
  background: var(--wb-surface);
}

.json-editor__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px 6px 12px;
  background: var(--wb-surface-muted);
  border-bottom: 1px solid var(--wb-border);
}

.json-editor__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--wb-text-secondary);
}

.json-editor__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 工具栏按钮：统一 28px 紧凑高度，与卡片条高度匹配（覆盖 .rule-form 的 32px 规则） */
.rule-form .json-editor__actions :deep(.el-button) {
  height: 28px;
  padding-top: 0;
  padding-bottom: 0;
  font-size: 12.5px;
}

.rule-form .json-editor__actions :deep(.el-button span) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.json-editor :deep(.el-textarea__inner) {
  border: none;
  border-radius: 0;
  box-shadow: none;
  padding: 12px 14px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}

.json-editor :deep(.el-textarea__inner:focus) {
  box-shadow: none;
}

.json-errors {
  margin: 0;
  padding: 10px 14px;
  border-top: 1px solid var(--wb-border);
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.json-errors code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  margin-right: 6px;
}

.danger-text {
  color: var(--wb-danger);
}

.delete-blocked {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--wb-warning);
}

.version-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.version-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--wb-text-secondary);
}

.version-item.is-active {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
