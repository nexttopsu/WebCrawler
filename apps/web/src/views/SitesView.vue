<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Pencil, Plus, RefreshCw, Trash2, Zap } from '@lucide/vue'
import type { PluginDto, ProxyDto, RuleDto, SiteConnectionTestDto, SiteDto } from '@webcrawler/shared'
import { createSite, deleteSite, getSite, listSites, patchSite, setSiteStatus, testSite } from '@/api/sites'
import { listPlugins } from '@/api/plugins'
import { listProxies } from '@/api/proxies'
import { listRules } from '@/api/rules'
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

const router = useRouter()

/** 模板里不能出现 `://`，统一从脚本传占位文案。 */
const BASE_URL_HINT = 'https://example.com'

const list = useListQuery<SiteDto, { keyword: string; status: string }>(
  (params) => listSites({ ...params, status: (params.status || undefined) as 'active' | 'inactive' | undefined }),
  { keyword: '', status: '' },
)

/* ------------------------------- 新建 / 编辑 ------------------------------- */

const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const proxyOptions = ref<ProxyDto[]>([])
const ruleOptions = ref<RuleDto[]>([])
/** 全流程插件（source 类型且已启用）：选中后由插件处理请求与数据获取，无需配置规则 */
const sourcePluginOptions = ref<PluginDto[]>([])

const form = reactive({
  name: '',
  baseUrl: '',
  description: '',
  status: 'active' as 'active' | 'inactive',
  defaultProxyId: null as number | null,
  defaultRuleId: null as number | null,
  pluginName: null as string | null,
})

/** 域名不再手填：实时从站点地址的主机名推导，保存时服务端会再算一次。 */
const derivedDomain = computed(() => {
  const raw = form.baseUrl.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
})

const rules: FormRules = {
  name: [{ required: true, message: '请填写网站名称', trigger: 'blur' }],
  baseUrl: [
    { required: true, message: '请填写站点地址', trigger: 'blur' },
    { pattern: /^https?:\/\/.+/, message: '需要以 http:// 或 https:// 开头', trigger: 'blur' },
  ],
}

const dialogTitle = computed(() => (editingId.value ? `编辑网站 #${editingId.value}` : '新增网站'))

async function loadOptions(siteId?: number): Promise<void> {
  try {
    const [proxies, rulesPage, pluginsPage] = await Promise.all([
      listProxies({ pageSize: 100 }),
      siteId ? listRules({ siteId, pageSize: 100, scope: 'site' }) : Promise.resolve(null),
      listPlugins({ type: 'source', enabled: 'true', pageSize: 100 }).catch(() => null),
    ])
    proxyOptions.value = proxies.items
    ruleOptions.value = rulesPage?.items ?? []
    sourcePluginOptions.value = pluginsPage?.items ?? []
  } catch {
    // 选项加载失败不阻塞主表单，用户仍可只填必填项
    proxyOptions.value = []
  }
}

async function openCreate(): Promise<void> {
  editingId.value = null
  Object.assign(form, {
    name: '',
    baseUrl: '',
    description: '',
    status: 'active',
    defaultProxyId: null,
    defaultRuleId: null,
    pluginName: null,
  })
  ruleOptions.value = []
  await loadOptions()
  dialogVisible.value = true
}

async function openEdit(row: SiteDto): Promise<void> {
  editingId.value = row.id
  Object.assign(form, {
    name: row.name,
    baseUrl: row.baseUrl,
    description: row.description ?? '',
    status: row.status,
    defaultProxyId: row.defaultProxyId,
    defaultRuleId: null,
    pluginName: row.pluginName,
  })
  dialogVisible.value = true
  await loadOptions(row.id)
  try {
    const detail = await getSite(row.id)
    form.defaultRuleId = detail.defaultRule?.id ?? null
  } catch {
    form.defaultRuleId = null
  }
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    // 域名不再随请求提交（由服务端从 baseUrl 推导）；
    // 创建时也不能带 defaultRuleId：规则必须先有站点，否则会被严格 Schema 判为未知字段。
    const payload = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      description: form.description.trim() || null,
      status: form.status,
      defaultProxyId: form.defaultProxyId,
      pluginName: form.pluginName,
    }
    if (editingId.value) {
      await patchSite(editingId.value, { ...payload, defaultRuleId: form.defaultRuleId })
      ElMessage.success('网站已更新')
    } else {
      await createSite(payload)
      ElMessage.success('网站已创建')
    }
    dialogVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

/* -------------------------------- 状态操作 -------------------------------- */

async function toggleStatus(row: SiteDto): Promise<void> {
  try {
    await setSiteStatus(row.id, row.status === 'active' ? 'inactive' : 'active')
    ElMessage.success(row.status === 'active' ? '已停用' : '已启用')
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

/* -------------------------------- 连接测试 -------------------------------- */

const testResult = ref<SiteConnectionTestDto | null>(null)
const testVisible = ref(false)
const testingId = ref<number | null>(null)

async function runTest(row: SiteDto): Promise<void> {
  testingId.value = row.id
  try {
    testResult.value = await testSite(row.id)
    testVisible.value = true
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    testingId.value = null
  }
}

/* --------------------------------- 删除 ---------------------------------- */

const deleteVisible = ref(false)
const deleteTarget = ref<SiteDto | null>(null)
const deleteLoading = ref(false)
const deleteBlocked = ref<string | null>(null)

function askDelete(row: SiteDto): void {
  deleteTarget.value = row
  deleteBlocked.value = null
  deleteVisible.value = true
}

async function confirmDelete(force = false): Promise<void> {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await deleteSite(deleteTarget.value.id, force)
    ElMessage.success('网站已删除')
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'CONFLICT') {
      deleteBlocked.value = error.message
    } else {
      ElMessage.error(errorMessage(error))
    }
  } finally {
    deleteLoading.value = false
  }
}

function goCategories(row: SiteDto): void {
  router.push({ path: '/categories', query: { siteId: String(row.id) } })
}
</script>

<template>
  <div class="view">
    <PageHeader title="网站管理" description="维护采集目标站点、默认代理与默认规则。">
      <template #actions>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
          <span>刷新</span>
        </el-button>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          <span>新增网站</span>
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar
        v-model="list.filters.keyword"
        placeholder="搜索名称或域名"
        @search="list.search()"
      />
      <el-select
        v-model="list.filters.status"
        placeholder="全部状态"
        clearable
        style="width: 140px"
        @change="list.search()"
      >
        <el-option label="启用" value="active" />
        <el-option label="停用" value="inactive" />
      </el-select>
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      empty-title="还没有网站"
      empty-description="添加一个目标站点后，才能创建栏目与规则"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column prop="name" label="名称" min-width="160">
        <template #default="{ row }">
          <div class="site-name">
            <span class="site-name__text">{{ row.name }}</span>
            <span class="wb-muted site-name__domain">{{ row.domain }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="站点地址" min-width="220">
        <template #default="{ row }">
          <a class="wb-mono link" :href="row.baseUrl" target="_blank" rel="noopener noreferrer">
            {{ row.baseUrl }}
          </a>
        </template>
      </el-table-column>

      <el-table-column label="插件" width="120">
        <template #default="{ row }">
          <span class="wb-muted">{{ row.pluginName ?? '默认' }}</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <StatusTag :status="row.status" />
        </template>
      </el-table-column>

      <el-table-column label="更新时间" width="150">
        <template #default="{ row }">
          <span class="wb-muted">{{ new Date(row.updatedAt).toLocaleString('zh-CN') }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="290" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text :loading="testingId === row.id" @click="runTest(row)">
              <Zap :size="13" />
              测试
            </el-button>
            <el-button size="small" text @click="goCategories(row)">栏目</el-button>
            <el-button size="small" text @click="openEdit(row)">
              <Pencil :size="13" />
              编辑
            </el-button>
            <el-button size="small" text @click="toggleStatus(row)">
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
            <el-button size="small" text type="danger" @click="askDelete(row)">
              <Trash2 :size="13" />
            </el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openCreate">新增网站</el-button>
      </template>
    </DataTable>

    <FormDialog
      v-model="dialogVisible"
      :title="dialogTitle"
      :loading="submitting"
      :width="560"
      description="域名由站点地址自动获取，无需单独填写；站点地址用于补全相对链接，必须带协议。"
      @submit="submit"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px" label-position="right">
        <el-form-item label="网站名称" prop="name">
          <el-input v-model="form.name" maxlength="50" placeholder="例如：示例新闻" />
        </el-form-item>
        <el-form-item label="站点地址" prop="baseUrl">
          <el-input v-model="form.baseUrl" :placeholder="BASE_URL_HINT" />
          <p class="form-hint">
            域名：<span class="wb-mono">{{ derivedDomain || '保存时从地址自动获取' }}</span>
          </p>
        </el-form-item>
        <el-form-item label="默认代理">
          <el-select v-model="form.defaultProxyId" clearable placeholder="直连（不使用代理）" style="width: 100%">
            <el-option
              v-for="proxy in proxyOptions"
              :key="proxy.id"
              :label="proxyLabel(proxy)"
              :value="proxy.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="全流程插件">
          <el-select
            v-model="form.pluginName"
            clearable
            filterable
            placeholder="默认流程（按规则采集）"
            style="width: 100%"
          >
            <el-option
              v-for="plugin in sourcePluginOptions"
              :key="plugin.name"
              :label="`${plugin.name} ${plugin.version}`"
              :value="plugin.name"
            />
          </el-select>
          <p class="form-hint">
            选择全流程插件后，采集由插件处理请求与数据获取，无需再配置规则；留空走默认流程。
          </p>
        </el-form-item>
        <el-form-item label="默认规则">
          <el-select
            v-model="form.defaultRuleId"
            clearable
            placeholder="不设置（由栏目规则决定）"
            style="width: 100%"
            :disabled="!editingId"
          >
            <el-option v-for="rule in ruleOptions" :key="rule.id" :label="`${rule.name} (v${rule.version})`" :value="rule.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="inactive">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
    </FormDialog>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除网站"
      :danger="true"
      :loading="deleteLoading"
      :confirm-text="deleteBlocked ? '解除引用并删除' : '删除'"
      @confirm="confirmDelete(Boolean(deleteBlocked))"
    >
      <p class="wb-secondary">{{ deleteTarget?.name }}（{{ deleteTarget?.domain }}）</p>
      <p v-if="deleteBlocked" class="delete-blocked">
        {{ deleteBlocked }}
        <br />
        继续删除只会解除栏目与规则对它的引用，历史文章与任务不会被删除。
      </p>
      <p v-else class="wb-secondary">删除后不可恢复，站点下的栏目需要先单独处理。</p>
    </ConfirmDialog>

    <el-dialog v-model="testVisible" title="连接测试结果" width="460" align-center>
      <dl v-if="testResult" class="wb-kv">
        <dt>结果</dt>
        <dd>
          <StatusTag :status="testResult.ok ? 'available' : 'unavailable'" :label="testResult.ok ? '连接成功' : '连接失败'" />
        </dd>
        <dt>HTTP 状态</dt>
        <dd>{{ testResult.statusCode ?? '—' }}</dd>
        <dt>耗时</dt>
        <dd>{{ testResult.elapsedMs }} ms</dd>
        <dt>页面标题</dt>
        <dd>{{ testResult.title ?? '—' }}</dd>
        <dt>最终地址</dt>
        <dd class="wb-mono">{{ testResult.finalUrl ?? testResult.url }}</dd>
        <dt>{{ testResult.ok ? '说明' : '错误' }}</dt>
        <dd :class="{ 'test-error': !testResult.ok }">{{ testResult.message }}</dd>
      </dl>
    </el-dialog>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.site-name {
  display: flex;
  flex-direction: column;
}

.site-name__text {
  font-weight: 500;
}

.site-name__domain {
  font-size: 11.5px;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
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

.test-error {
  color: var(--wb-danger);
}
</style>
