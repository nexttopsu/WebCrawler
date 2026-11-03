<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Pencil, Play, Plus, RefreshCw, Trash2, Zap } from '@lucide/vue'
import type {
  CategoryDto,
  CategoryTestDto,
  ProxyDto,
  RuleDto,
  SiteDto,
} from '@webcrawler/shared'
import {
  createCategory,
  deleteCategory,
  listCategories,
  patchCategory,
  setCategoryEnabled,
  testCategory,
} from '@/api/categories'
import { listSites } from '@/api/sites'
import { listRules } from '@/api/rules'
import { listProxies } from '@/api/proxies'
import { createTask } from '@/api/tasks'
import { ApiClientError, errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import { proxyLabel } from '@/lib/proxy'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()

/** 模板里不能出现 `://`，统一从脚本传占位文案。 */
const LIST_URL_HINT = 'https://example.com/news'

const initialSiteId = Number(route.query.siteId ?? 0) || undefined

const list = useListQuery<CategoryDto, { keyword: string; siteId?: number; enabled: string }>(
  (params) =>
    listCategories({
      ...params,
      siteId: params.siteId || undefined,
      enabled: (params.enabled || undefined) as 'true' | 'false' | undefined,
    }),
  { keyword: '', siteId: initialSiteId, enabled: '' },
)

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

/* ------------------------------- 新建 / 编辑 ------------------------------- */

const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  siteId: initialSiteId ?? null,
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

watch(
  () => form.siteId,
  (siteId) => {
    void loadRules(siteId)
    if (!editingId.value) form.ruleId = null
  },
)

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    siteId: list.filters.siteId ?? initialSiteId ?? null,
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
  dialogVisible.value = true
}

function openEdit(row: CategoryDto): void {
  editingId.value = row.id
  Object.assign(form, {
    siteId: row.siteId,
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
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || !form.siteId) return

  submitting.value = true
  try {
    const payload = {
      siteId: form.siteId,
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
      await patchCategory(editingId.value, payload)
      ElMessage.success('栏目已更新')
    } else {
      await createCategory(payload)
      ElMessage.success('栏目已创建')
    }
    dialogVisible.value = false
    await list.load()
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
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

async function toggle(row: CategoryDto): Promise<void> {
  try {
    await setCategoryEnabled(row.id, !row.enabled)
    ElMessage.success(row.enabled ? '已停用' : '已启用')
    await list.load()
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

function askDelete(row: CategoryDto): void {
  deleteTarget.value = row
  deleteBlocked.value = null
  deleteVisible.value = true
}

async function confirmDelete(force = false): Promise<void> {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await deleteCategory(deleteTarget.value.id, force)
    ElMessage.success('栏目已删除')
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'CONFLICT') deleteBlocked.value = error.message
    else ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

void loadOptions()
</script>

<template>
  <div class="view">
    <PageHeader title="栏目管理" description="栏目对应一个列表页地址，是采集任务的最小执行单元。">
      <template #actions>
        <el-button :disabled="selected.length === 0" @click="batchCrawl">
          <Play :size="14" />
          <span>批量采集{{ selected.length ? `（${selected.length}）` : '' }}</span>
        </el-button>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          <span>新建栏目</span>
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索栏目名称或地址" @search="list.search()" />
      <el-select
        v-model="list.filters.siteId"
        placeholder="全部网站"
        clearable
        filterable
        style="width: 190px"
        @change="list.search()"
      >
        <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
      </el-select>
      <el-select v-model="list.filters.enabled" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="启用" value="true" />
        <el-option label="停用" value="false" />
      </el-select>
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      selectable
      empty-title="还没有栏目"
      empty-description="栏目需要归属到一个网站，并绑定采集规则"
      @selection-change="onSelectionChange"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column prop="name" label="栏目" min-width="170">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-title">{{ row.name }}</span>
            <span class="wb-muted cell-sub">{{ siteNameMap.get(row.siteId) ?? `站点 #${row.siteId}` }}</span>
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

      <el-table-column label="操作" width="300" fixed="right">
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
            <el-button size="small" text @click="openEdit(row)">
              <Pencil :size="13" />
              编辑
            </el-button>
            <el-button size="small" text @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button size="small" text type="danger" @click="askDelete(row)">
              <Trash2 :size="13" />
            </el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openCreate">新建栏目</el-button>
      </template>
    </DataTable>

    <FormDialog
      v-model="dialogVisible"
      :title="editingId ? `编辑栏目 #${editingId}` : '新建栏目'"
      :loading="submitting"
      :width="580"
      description="列表页地址必须与规则中的列表项选择器匹配，可先用「试采」验证。"
      @submit="submit"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="所属网站" prop="siteId">
          <el-select v-model="form.siteId" filterable placeholder="选择网站" style="width: 100%">
            <el-option v-for="site in siteOptions" :key="site.id" :label="`${site.name} (${site.domain})`" :value="site.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="栏目名称" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="例如：要闻" />
        </el-form-item>
        <el-form-item label="列表页" prop="listUrl">
          <el-input v-model="form.listUrl" :placeholder="LIST_URL_HINT" />
        </el-form-item>
        <el-form-item label="栏目编码">
          <el-input v-model="form.code" maxlength="50" placeholder="可选，站点内唯一，如 news" />
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
      :confirm-text="deleteBlocked ? '解除引用并删除' : '删除'"
      @confirm="confirmDelete(Boolean(deleteBlocked))"
    >
      <p class="wb-secondary">{{ deleteTarget?.name }}</p>
      <p v-if="deleteBlocked" class="delete-blocked">
        {{ deleteBlocked }}
        <br />
        继续删除只解除引用，历史文章与任务记录会保留。
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
