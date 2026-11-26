<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { ChevronRight, Copy, FolderPlus, Pencil, Play, Plus, RefreshCw, Trash2, Zap } from '@lucide/vue'
import type {
  CategoryDto,
  CategoryTestDto,
  CategoryTreeNodeDto,
  ProxyDto,
  RuleDto,
  SiteDto,
} from '@webcrawler/shared'
import {
  createCategory,
  deleteCategory,
  patchCategory,
  setCategoryEnabled,
  testCategory,
} from '@/api/categories'
import { listSites } from '@/api/sites'
import { listRules } from '@/api/rules'
import { listProxies } from '@/api/proxies'
import { createTask } from '@/api/tasks'
import { ApiClientError, errorMessage } from '@/api/client'
import { useCategoryTree } from '@/composables/useCategoryTree'
import { proxyLabel } from '@/lib/proxy'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import CategorySelect from '@/components/common/CategorySelect.vue'

const route = useRoute()
const router = useRouter()

/** 模板里不能出现 `://`，统一从脚本传占位文案。 */
const LIST_URL_HINT = 'https://example.com/news'

const initialSiteId = Number(route.query.siteId ?? 0) || undefined

/**
 * 表格行：刻意不带 `children` 字段。
 * el-table 的 treeProps 默认就会识别 `children`，只要行上有这个字段
 * 就会画出展开箭头并嵌套子行；子栏目数量改用 childCount 单独传递。
 */
type CategoryRow = Omit<CategoryTreeNodeDto, 'children'> & { childCount: number }

/**
 * 全量栏目树（模块级共享，见 useCategoryTree）。
 *
 * 上级选择器、归属路径、层级导航都基于同一份数据，
 * 不会出现「列表里看不到父栏目」的情况。
 */
const { tree: allRows, loading, error, load: reloadTree, ancestorPathMap } = useCategoryTree()
const filters = reactive<{ keyword: string; siteId?: number; enabled: string }>({
  keyword: '',
  siteId: initialSiteId,
  enabled: '',
})

/** URL 里的 parentId 表示当前打开的上级栏目；没有则是根层级。 */
function parentIdFromQuery(): number | null {
  const id = Number(route.query.parentId ?? 0)
  return Number.isInteger(id) && id > 0 ? id : null
}

const currentParentId = ref<number | null>(parentIdFromQuery())
const page = ref(1)
const pageSize = ref(20)

/** 层级写回 URL：刷新、复制链接、地址栏直接改参数都能停在同一个层级。 */
function syncParentQuery(): void {
  const query = { ...route.query }
  if (currentParentId.value === null) delete query.parentId
  else query.parentId = String(currentParentId.value)
  const unchanged =
    Object.keys(query).length === Object.keys(route.query).length &&
    Object.keys(query).every((key) => query[key] === route.query[key])
  if (!unchanged) void router.replace({ query })
}

function setLevel(id: number | null): void {
  currentParentId.value = id
  page.value = 1
  selected.value = []
  syncParentQuery()
}

// 地址栏里的 parentId 变化时同步层级（前进/后退或直接改地址）
watch(
  () => route.query.parentId,
  (raw) => {
    const id = Number(raw ?? 0)
    const next = Number.isInteger(id) && id > 0 ? id : null
    if (next !== currentParentId.value) {
      currentParentId.value = next
      page.value = 1
      selected.value = []
    }
  },
)

async function load(): Promise<void> {
  await reloadTree()
  // URL 指向的层级已不存在（栏目被删或链接失效）时退回根层级并清理 URL
  if (currentParentId.value !== null && !findNode(allRows.value, currentParentId.value)) {
    setLevel(null)
  }
}

/** 从根到当前层级的节点链（含当前节点），供面包屑与取子级列表使用。 */
const levelAncestors = computed<CategoryTreeNodeDto[]>(() => {
  if (currentParentId.value === null) return []
  const walk = (nodes: CategoryTreeNodeDto[], chain: CategoryTreeNodeDto[]): CategoryTreeNodeDto[] | null => {
    for (const node of nodes) {
      const next = [...chain, node]
      if (node.id === currentParentId.value) return next
      const found = walk(node.children, next)
      if (found) return found
    }
    return null
  }
  return walk(allRows.value, []) ?? []
})

/** 表格只渲染当前层级（同级栏目），子层级要靠点击栏目名进入。 */
const levelRows = computed<CategoryTreeNodeDto[]>(() => {
  if (currentParentId.value === null) return allRows.value
  return levelAncestors.value.at(-1)?.children ?? []
})

function enterLevel(row: CategoryRow): void {
  if (!row.childCount) return
  setLevel(row.id)
}

// 切换站点筛选时，若当前层级属于别的站点则退回根层级
watch(
  () => filters.siteId,
  (siteId) => {
    if (!siteId || currentParentId.value === null) return
    const current = levelAncestors.value.at(-1)
    if (current && current.siteId !== siteId) setLevel(null)
  },
)

/** 名称下方的归属说明：「站点 · 上级路径」，顶级栏目只显示站点。 */
function categorySubLabel(row: CategoryDto): string {
  const site = siteNameMap.value.get(row.siteId) ?? `站点 #${row.siteId}`
  const path = ancestorPathMap.value.get(row.id) ?? ''
  return path ? `${site} · ${path}` : site
}

/** 筛选只作用于当前层级，不再跨层级搜索。 */
const visibleRows = computed<CategoryTreeNodeDto[]>(() => {
  const keyword = filters.keyword.trim().toLowerCase()
  const enabledOnly = filters.enabled === 'true'
  const disabledOnly = filters.enabled === 'false'
  const siteId = filters.siteId
  const nodes = levelRows.value
  if (!keyword && !enabledOnly && !disabledOnly && !siteId) return nodes

  return nodes.filter((node) => {
    if (siteId && node.siteId !== siteId) return false
    if (enabledOnly && !node.enabled) return false
    if (disabledOnly && node.enabled) return false
    return (
      !keyword ||
      node.name.toLowerCase().includes(keyword) ||
      (node.code ?? '').toLowerCase().includes(keyword) ||
      node.listUrl.toLowerCase().includes(keyword)
    )
  })
})

/** 分页只切当前层级的数据，避免栏目多时一次渲染整张表。 */
const totalRows = computed(() => visibleRows.value.length)
const maxPage = computed(() => Math.max(1, Math.ceil(totalRows.value / pageSize.value)))
const pagedRows = computed<CategoryRow[]>(() => {
  const start = (page.value - 1) * pageSize.value
  return visibleRows.value.slice(start, start + pageSize.value).map(({ children, ...row }) => ({
    ...row,
    childCount: children?.length ?? 0,
  }))
})

watch(maxPage, (value) => {
  if (page.value > value) page.value = value
})

const isFiltered = computed(
  () => Boolean(filters.keyword || filters.enabled || (filters.siteId ?? undefined) !== initialSiteId),
)

function resetFilters(): void {
  filters.keyword = ''
  filters.siteId = initialSiteId
  filters.enabled = ''
}

const siteOptions = ref<SiteDto[]>([])
const ruleOptions = ref<RuleDto[]>([])
const proxyOptions = ref<ProxyDto[]>([])
const siteNameMap = computed(() => new Map(siteOptions.value.map((site) => [site.id, site.name])))

async function loadOptions(): Promise<void> {
  try {
    const [sites, proxies] = await Promise.all([listSites({ pageSize: 100 }), listProxies({ pageSize: 100 })])
    siteOptions.value = sites.items
    proxyOptions.value = proxies.items
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

async function loadRules(siteId: number | null | undefined): Promise<void> {
  if (!siteId) {
    ruleOptions.value = []
    return
  }
  try {
    const page = await listRules({ siteId, pageSize: 100 })
    ruleOptions.value = page.items
  } catch {
    ruleOptions.value = []
  }
}

/* ------------------------------- 新建 / 编辑 / 复制 ------------------------------- */

const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
/** 复制来源：非空时弹窗处于「复制栏目」模式，保存会新建一条栏目 */
const copyFromId = ref<number | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  siteId: initialSiteId ?? null,
  parentId: null as number | null,
  name: '',
  code: '',
  listUrl: '',
  ruleId: null as number | null,
  proxyId: null as number | null,
  enabled: true,
  crawlInterval: 0,
  sortOrder: 0,
  description: '',
})

const rules: FormRules = {
  siteId: [{ required: true, message: '请选择所属网站', trigger: 'change' }],
  name: [{ required: true, message: '请填写栏目名称', trigger: 'blur' }],
  listUrl: [
    { required: true, message: '请填写列表页地址', trigger: 'blur' },
    { pattern: /^https?:\/\/.+/, message: '需要以 http:// 或 https:// 开头', trigger: 'blur' },
  ],
}

/** 用户切换站点：栏目不能跨站点挂载，上级一并清空。 */
function onSiteChange(siteId: number | null): void {
  void loadRules(siteId)
  form.ruleId = null
  form.parentId = null
}

function openCreate(parent?: CategoryDto): void {
  editingId.value = null
  copyFromId.value = null
  // 顶部「新建栏目」默认建在当前浏览的层级里；行内「子栏目」仍以该行为上级
  const defaultParent = parent ?? (currentParentId.value === null ? undefined : levelAncestors.value.at(-1))
  Object.assign(form, {
    siteId: defaultParent?.siteId ?? filters.siteId ?? initialSiteId ?? null,
    parentId: defaultParent?.id ?? null,
    name: '',
    code: '',
    listUrl: '',
    ruleId: null,
    proxyId: null,
    enabled: true,
    crawlInterval: 0,
    sortOrder: 0,
    description: '',
  })
  void loadRules(form.siteId)
  dialogVisible.value = true
}

function openEdit(row: CategoryDto): void {
  editingId.value = row.id
  copyFromId.value = null
  Object.assign(form, {
    siteId: row.siteId,
    parentId: row.parentId,
    name: row.name,
    code: row.code ?? '',
    listUrl: row.listUrl,
    ruleId: row.ruleId,
    proxyId: row.proxyId,
    enabled: row.enabled,
    crawlInterval: row.crawlInterval,
    sortOrder: row.sortOrder,
    description: row.description ?? '',
  })
  void loadRules(row.siteId)
  dialogVisible.value = true
}

/**
 * 复制栏目：把当前行的配置带进「新建」表单。
 *
 * 同一站点内 listUrl 与 code 都是唯一的，源栏目本身已占用，因此这里清空 code、
 * 保留 listUrl 让用户改成新的列表页地址后再保存，不会直接撞唯一索引。
 * 上级沿用源栏目的上级，副本与源栏目并列在同一层级。
 */
function openCopy(row: CategoryDto): void {
  editingId.value = null
  copyFromId.value = row.id
  Object.assign(form, {
    siteId: row.siteId,
    parentId: row.parentId,
    name: `${row.name} 副本`.slice(0, 50),
    code: '',
    listUrl: row.listUrl,
    ruleId: row.ruleId,
    proxyId: row.proxyId,
    enabled: row.enabled,
    crawlInterval: row.crawlInterval,
    sortOrder: row.sortOrder,
    description: row.description ?? '',
  })
  void loadRules(row.siteId)
  dialogVisible.value = true
}

/* ------------------------------ 上级栏目选择器 ------------------------------ */

function findNode(nodes: CategoryTreeNodeDto[], id: number): CategoryTreeNodeDto | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return null
}

function collectSubtreeIds(node: CategoryTreeNodeDto, acc = new Set<number>()): Set<number> {
  acc.add(node.id)
  for (const child of node.children) collectSubtreeIds(child, acc)
  return acc
}

/**
 * 编辑时排除自己与自己的后代（挂到自己子树下会成环）。
 * 前端只是提前置灰非法选项，真正的成环校验在服务端。
 */
const excludedParentIds = computed<number[]>(() => {
  if (!editingId.value) return []
  const current = findNode(allRows.value, editingId.value)
  return current ? [...collectSubtreeIds(current)] : [editingId.value]
})

const dialogTitle = computed(() => {
  if (editingId.value) return `编辑栏目 #${editingId.value}`
  if (copyFromId.value) return `复制栏目 #${copyFromId.value}`
  return '新建栏目'
})

const dialogDescription = computed(() =>
  copyFromId.value
    ? '已带入原栏目的规则、代理与采集配置；同站点内列表页地址唯一，请改成新的列表页地址后再保存。'
    : '列表页地址必须与规则中的列表项选择器匹配，可先用「试采」验证。',
)

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || !form.siteId) return

  submitting.value = true
  try {
    // 编辑时站点归属不可变更（改站点会破坏文章/任务的引用，后端直接拒绝 siteId），只在新建时提交
    const base = {
      parentId: form.parentId,
      name: form.name.trim(),
      code: form.code.trim() || null,
      listUrl: form.listUrl.trim(),
      ruleId: form.ruleId,
      proxyId: form.proxyId,
      enabled: form.enabled,
      crawlInterval: form.crawlInterval,
      sortOrder: form.sortOrder,
      description: form.description.trim() || null,
    }
    if (editingId.value) {
      await patchCategory(editingId.value, base)
      ElMessage.success('栏目已更新')
    } else {
      await createCategory({ ...base, siteId: form.siteId! })
      ElMessage.success(copyFromId.value ? '已复制为新栏目' : '栏目已创建')
    }
    dialogVisible.value = false
    await load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

/* -------------------------------- 采集操作 -------------------------------- */

const crawlingId = ref<number | null>(null)

async function crawl(row: CategoryDto): Promise<void> {
  crawlingId.value = row.id
  try {
    const task = await createTask({ siteId: row.siteId, type: 'category', categoryIds: [row.id] })
    ElMessage.success(`已创建采集任务 #${task.id}`)
    router.push(`/tasks/${task.id}`)
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    crawlingId.value = null
  }
}

const selected = ref<CategoryDto[]>([])

function onSelectionChange(rows: unknown[]): void {
  selected.value = rows as CategoryDto[]
}

async function batchCrawl(): Promise<void> {
  if (selected.value.length === 0) return
  const bySite = new Map<number, number[]>()
  for (const row of selected.value) {
    const ids = bySite.get(row.siteId) ?? []
    ids.push(row.id)
    bySite.set(row.siteId, ids)
  }

  try {
    let created = 0
    for (const [siteId, categoryIds] of bySite) {
      await createTask({ siteId, type: 'batch', categoryIds })
      created += 1
    }
    ElMessage.success(`已创建 ${created} 个批量采集任务（按站点分组）`)
    selected.value = []
    await load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

async function toggle(row: CategoryDto): Promise<void> {
  try {
    await setCategoryEnabled(row.id, !row.enabled)
    ElMessage.success(row.enabled ? '已停用' : '已启用')
    await load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

/* -------------------------------- 试采 -------------------------------- */

const testVisible = ref(false)
const testResult = ref<CategoryTestDto | null>(null)
const testingId = ref<number | null>(null)

async function runTest(row: CategoryDto): Promise<void> {
  testingId.value = row.id
  try {
    testResult.value = await testCategory(row.id)
    testVisible.value = true
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    testingId.value = null
  }
}

/* -------------------------------- 删除 -------------------------------- */

const deleteVisible = ref(false)
const deleteTarget = ref<CategoryDto | null>(null)
const deleteLoading = ref(false)
const deleteBlocked = ref<string | null>(null)
/** 有子栏目时删除一定失败，直接置灰确认按钮，不发起请求 */
const deleteHasChildren = ref(false)

function askDelete(row: CategoryRow): void {
  deleteTarget.value = row
  const children = row.childCount
  deleteHasChildren.value = children > 0
  deleteBlocked.value = children > 0 ? `该栏目下还有 ${children} 个子栏目，需先把子栏目删除或移走` : null
  deleteVisible.value = true
}

async function confirmDelete(force = false): Promise<void> {
  if (!deleteTarget.value || deleteHasChildren.value) return
  deleteLoading.value = true
  try {
    await deleteCategory(deleteTarget.value.id, force)
    ElMessage.success('栏目已删除')
    deleteVisible.value = false
    await load()
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'CONFLICT') deleteBlocked.value = error.message
    else ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

void loadOptions()
void load()
</script>

<template>
  <div class="view">
    <PageHeader
      title="栏目管理"
      description="栏目对应一个列表页地址，是采集任务的最小执行单元；上级栏目只表达归属关系，采集时互不包含。"
    >
      <template #actions>
        <el-button :disabled="selected.length === 0" @click="batchCrawl">
          <Play :size="14" />
          <span>批量采集{{ selected.length ? `（${selected.length}）` : '' }}</span>
        </el-button>
        <el-button :loading="loading" @click="load()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button type="primary" @click="openCreate()">
          <Plus :size="14" />
          <span>新建栏目</span>
        </el-button>
      </template>
    </PageHeader>

    <div class="level-bar wb-card">
      <el-breadcrumb separator="/">
        <el-breadcrumb-item>
          <button
            v-if="currentParentId !== null"
            type="button"
            class="crumb-link"
            @click="setLevel(null)"
          >
            全部栏目
          </button>
          <span v-else class="crumb-current">全部栏目</span>
        </el-breadcrumb-item>
        <el-breadcrumb-item v-for="(node, index) in levelAncestors" :key="node.id">
          <button
            v-if="index < levelAncestors.length - 1"
            type="button"
            class="crumb-link"
            @click="setLevel(node.id)"
          >
            {{ node.name }}
          </button>
          <span v-else class="crumb-current">{{ node.name }}</span>
        </el-breadcrumb-item>
      </el-breadcrumb>
      <span class="level-count">当前层级 {{ totalRows }} 个栏目</span>
    </div>

    <FilterBar :active="isFiltered" @reset="resetFilters">
      <SearchBar v-model="filters.keyword" placeholder="搜索栏目名称或地址" />
      <el-select v-model="filters.siteId" placeholder="全部网站" clearable filterable style="width: 190px">
        <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
      </el-select>
      <el-select v-model="filters.enabled" placeholder="全部状态" clearable style="width: 130px">
        <el-option label="启用" value="true" />
        <el-option label="停用" value="false" />
      </el-select>
    </FilterBar>

    <DataTable
      :key="currentParentId ?? 'root'"
      :rows="pagedRows"
      :loading="loading"
      :error="error"
      :page="page"
      :page-size="pageSize"
      :total="totalRows"
      row-key="id"
      selectable
      empty-title="还没有栏目"
      empty-description="栏目需要归属到一个网站，并绑定采集规则"
      @update:page="page = $event"
      @update:page-size="pageSize = $event"
      @selection-change="onSelectionChange"
      @retry="load()"
      @refresh="load()"
    >
      <el-table-column prop="name" label="栏目" min-width="170">
        <template #default="{ row }">
          <div class="cell-main">
            <button
              v-if="row.childCount"
              type="button"
              class="cell-title drill-link"
              :title="`查看 ${row.childCount} 个子栏目`"
              @click="enterLevel(row)"
            >
              {{ row.name }}
              <ChevronRight :size="14" />
              <span class="child-count">{{ row.childCount }}</span>
            </button>
            <span v-else class="cell-title">{{ row.name }}</span>
            <span class="wb-muted cell-sub">{{ categorySubLabel(row) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="列表页" min-width="240">
        <template #default="{ row }">
          <a class="wb-mono link" :href="row.listUrl" target="_blank" rel="noopener noreferrer">{{ row.listUrl }}</a>
        </template>
      </el-table-column>

      <el-table-column label="规则 / 代理" width="150">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ row.ruleId ? `规则 #${row.ruleId}` : '未绑定规则' }}</span>
            <span class="wb-muted cell-sub">{{ row.proxyId ? `代理 #${row.proxyId}` : '直连' }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <StatusTag :status="row.enabled ? 'active' : 'inactive'" />
        </template>
      </el-table-column>

      <el-table-column label="操作" width="436" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text :loading="crawlingId === row.id" @click="crawl(row)">
              <Play :size="13" />
              采集
            </el-button>
            <el-button size="small" text :loading="testingId === row.id" @click="runTest(row)">
              <Zap :size="13" />
              试采
            </el-button>
            <el-button size="small" text @click="openCreate(row)">
              <FolderPlus :size="13" />
              子栏目
            </el-button>
            <el-button size="small" text @click="openEdit(row)">
              <Pencil :size="13" />
              编辑
            </el-button>
            <el-button size="small" text @click="openCopy(row)">
              <Copy :size="13" />
              复制
            </el-button>
            <el-button size="small" text @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button size="small" text type="danger" @click="askDelete(row)">
              <Trash2 :size="13" />
            </el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openCreate()">新建栏目</el-button>
      </template>
    </DataTable>

    <FormDialog
      v-model="dialogVisible"
      :title="dialogTitle"
      :loading="submitting"
      :width="580"
      :description="dialogDescription"
      @submit="submit"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="所属网站" prop="siteId">
          <el-select
            v-model="form.siteId"
            filterable
            placeholder="选择网站"
            :disabled="Boolean(editingId)"
            style="width: 100%"
            @change="onSiteChange"
          >
            <el-option v-for="site in siteOptions" :key="site.id" :label="`${site.name} (${site.domain})`" :value="site.id" />
          </el-select>
          <p v-if="editingId" class="field-hint">站点归属创建后不可修改，文章与任务都挂在原站点下。</p>
        </el-form-item>
        <el-form-item label="上级栏目">
          <CategorySelect
            v-model="form.parentId"
            :site-id="form.siteId"
            :exclude-ids="excludedParentIds"
            :disabled="!form.siteId"
            placeholder="不选则为顶级栏目"
          />
          <p class="field-hint">上级只表示归属关系；采集、统计都只作用于栏目本身。</p>
        </el-form-item>
        <el-form-item label="栏目名称" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="例如：要闻" />
        </el-form-item>
        <el-form-item label="列表页" prop="listUrl">
          <el-input v-model="form.listUrl" :placeholder="LIST_URL_HINT" />
          <p v-if="copyFromId" class="field-hint">这是原栏目的地址，同站点内唯一，保存前请改成新的列表页地址。</p>
        </el-form-item>
        <el-form-item label="栏目编码">
          <el-input v-model="form.code" maxlength="50" placeholder="可选，站点内唯一，如 news" />
          <p v-if="copyFromId" class="field-hint">栏目编码同样站点内唯一，复制时已清空，需要时再填。</p>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number
            v-model="form.sortOrder"
            :min="-9999"
            :max="9999"
            controls-position="right"
            style="width: 100%"
          />
          <p class="field-hint">同级栏目按排序值升序展示，越小越靠前。</p>
        </el-form-item>
        <el-form-item label="采集规则">
          <el-select v-model="form.ruleId" clearable placeholder="继承站点默认规则" style="width: 100%">
            <el-option v-for="rule in ruleOptions" :key="rule.id" :label="`${rule.name} (v${rule.version})`" :value="rule.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="代理">
          <el-select v-model="form.proxyId" clearable placeholder="继承网站默认代理" style="width: 100%">
            <el-option
              v-for="proxy in proxyOptions"
              :key="proxy.id"
              :label="proxyLabel(proxy)"
              :value="proxy.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
    </FormDialog>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除栏目"
      :danger="true"
      :loading="deleteLoading"
      :confirm-disabled="deleteHasChildren"
      :confirm-text="deleteBlocked && !deleteHasChildren ? '解除引用并删除' : '删除'"
      @confirm="confirmDelete(Boolean(deleteBlocked))"
    >
      <p class="wb-secondary">{{ deleteTarget?.name }}</p>
      <p v-if="deleteBlocked" class="delete-blocked">
        {{ deleteBlocked }}
        <template v-if="!deleteHasChildren">
          <br />
          继续删除只解除引用，历史文章与任务记录会保留。
        </template>
      </p>
      <p v-else class="wb-secondary">删除后不可恢复。</p>
    </ConfirmDialog>

    <el-dialog v-model="testVisible" title="栏目试采结果" width="620" align-center>
      <template v-if="testResult">
        <dl class="wb-kv">
          <dt>结果</dt>
          <dd>
            <StatusTag :status="testResult.ok ? 'available' : 'unavailable'" :label="testResult.ok ? '命中了列表项' : '未命中'" />
          </dd>
          <dt>模式</dt>
          <dd>{{ testResult.mode === 'browser' ? '浏览器' : 'HTTP' }}</dd>
          <dt>HTTP 状态</dt>
          <dd>{{ testResult.statusCode ?? '—' }}</dd>
          <dt>耗时</dt>
          <dd>{{ testResult.elapsedMs }} ms</dd>
          <dt>列表项 / 链接</dt>
          <dd>{{ testResult.itemCount }} / {{ testResult.linkCount }}</dd>
          <dt>说明</dt>
          <dd>{{ testResult.message }}</dd>
        </dl>
        <div v-if="testResult.links.length" class="test-links">
          <p class="wb-muted">前 {{ testResult.links.length }} 条链接</p>
          <ul>
            <li v-for="(link, index) in testResult.links" :key="index">
              <span class="wb-mono">{{ link.url }}</span>
              <span v-if="link.title" class="wb-muted"> · {{ link.title }}</span>
            </li>
          </ul>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.level-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 16px;
}

.level-bar :deep(.el-breadcrumb) {
  display: flex;
  align-items: center;
  font-size: 13px;
}

.crumb-link,
.drill-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--wb-primary);
  font: inherit;
  cursor: pointer;
}

.crumb-link:hover,
.drill-link:hover {
  color: var(--wb-primary-hover);
  text-decoration: underline;
}

.crumb-current {
  color: var(--wb-text);
  font-weight: 600;
}

.level-count {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.cell-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cell-title,
.cell-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-title {
  font-weight: 500;
}

.drill-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}

.child-count {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 11px;
  font-weight: 500;
}

.cell-sub {
  font-size: 11.5px;
}

.link {
  color: var(--wb-primary);
  word-break: break-all;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 0;
  flex-wrap: nowrap;
}

/* Element 的 text 按钮默认左右各 8px 内边距，一行放 5 个就会被挤到换行 */
.row-actions :deep(.el-button) {
  padding: 4px 6px;
  white-space: nowrap;
}

.delete-blocked {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--wb-warning);
  line-height: 1.7;
}

.field-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--wb-text-muted);
  line-height: 1.6;
}

.test-links {
  margin-top: 14px;
}

.test-links ul {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
</style>
