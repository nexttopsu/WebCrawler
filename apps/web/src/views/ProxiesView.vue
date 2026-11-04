<script setup lang="ts">
/**
 * 代理管理。
 *
 * 密码是单向写入：列表只显示 `hasPassword`，表单里留空表示不改动，
 * 勾选「清除密码」才会真正清空。任何地方都不回显明文或密文。
 */
import { reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { KeyRound, Pencil, Plus, RefreshCw, Trash2, Zap } from '@lucide/vue'
import type { ProxyDto, ProxyTestResultDto } from '@webcrawler/shared'
import {
  createProxy,
  deleteProxy,
  listProxies,
  setProxyEnabled,
  testProxy,
  updateProxy,
} from '@/api/proxies'
import { ApiClientError, errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import { proxyEndpoint } from '@/lib/proxy'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const list = useListQuery<ProxyDto, { keyword: string; type: string; status: string; enabled: string }>(
  (params) =>
    listProxies({
      ...params,
      type: (params.type || undefined) as 'http' | 'https' | undefined,
      status: (params.status || undefined) as ProxyDto['status'] | undefined,
      enabled: (params.enabled || undefined) as 'true' | 'false' | undefined,
    }),
  { keyword: '', type: '', status: '', enabled: '' },
)

/* ------------------------------- 新建 / 编辑 ------------------------------- */

const dialogVisible = ref(false)
const editing = ref<ProxyDto | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  name: '',
  type: 'http' as 'http' | 'https',
  host: '',
  port: 8080,
  username: '',
  password: '',
  clearPassword: false,
  enabled: true,
})

const rules: FormRules = {
  host: [{ required: true, message: '请填写代理主机', trigger: 'blur' }],
  port: [{ required: true, message: '请填写端口', trigger: 'change' }],
}

function openCreate(): void {
  editing.value = null
  Object.assign(form, {
    name: '',
    type: 'http',
    host: '',
    port: 8080,
    username: '',
    password: '',
    clearPassword: false,
    enabled: true,
  })
  dialogVisible.value = true
}

function openEdit(row: ProxyDto): void {
  editing.value = row
  Object.assign(form, {
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username ?? '',
    password: '',
    clearPassword: false,
    enabled: row.enabled,
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const base = {
      name: form.name.trim() || undefined,
      type: form.type,
      host: form.host.trim(),
      port: form.port,
      username: form.username.trim() || null,
      enabled: form.enabled,
    }

    if (editing.value) {
      // password 不传 = 不改；传 null = 清空；传字符串 = 覆盖
      const patch: Record<string, unknown> = { ...base }
      if (form.clearPassword) patch.password = null
      else if (form.password) patch.password = form.password
      await updateProxy(editing.value.id, patch)
      ElMessage.success('代理已更新')
    } else {
      await createProxy({ ...base, password: form.password || undefined })
      ElMessage.success('代理已创建')
    }
    dialogVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

/* --------------------------------- 测试 --------------------------------- */

const testingId = ref<number | null>(null)
const testVisible = ref(false)
const testTarget = ref<ProxyDto | null>(null)
const testResult = ref<ProxyTestResultDto | null>(null)
const testError = ref<string | null>(null)

async function runTest(row: ProxyDto): Promise<void> {
  testingId.value = row.id
  testTarget.value = row
  testResult.value = null
  testError.value = null
  try {
    testResult.value = await testProxy(row.id)
    testVisible.value = true
    await list.load()
  } catch (error) {
    // 测试失败也要展示原因，但不回显账号密码
    testError.value = errorMessage(error)
    testVisible.value = true
  } finally {
    testingId.value = null
  }
}

/* --------------------------------- 启停 --------------------------------- */

async function toggle(row: ProxyDto): Promise<void> {
  try {
    await setProxyEnabled(row.id, !row.enabled)
    ElMessage.success(row.enabled ? '已禁用' : '已启用')
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

/* --------------------------------- 删除 --------------------------------- */

const deleteVisible = ref(false)
const deleteTarget = ref<ProxyDto | null>(null)
const deleteLoading = ref(false)
const deleteBlocked = ref<string | null>(null)

function askDelete(row: ProxyDto): void {
  deleteTarget.value = row
  deleteBlocked.value = null
  deleteVisible.value = true
}

async function confirmDelete(force = false): Promise<void> {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await deleteProxy(deleteTarget.value.id, force)
    ElMessage.success('代理已删除')
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'CONFLICT') deleteBlocked.value = error.message
    else ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

/* --------------------------------- 展示辅助 -------------------------------- */

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function successRate(row: ProxyDto): string {
  if (row.requestCount === 0) return '—'
  return `${Math.round((row.successCount / row.requestCount) * 100)}%`
}
</script>

<template>
  <div class="view">
    <PageHeader title="代理管理" description="代理密码加密存储，任何接口都不会返回明文；测试会真实发起一次请求。">
      <template #actions>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          <span>新增代理</span>
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索名称或主机" @search="list.search()" />
      <el-select v-model="list.filters.type" placeholder="全部协议" clearable style="width: 130px" @change="list.search()">
        <el-option label="HTTP" value="http" />
        <el-option label="HTTPS" value="https" />
      </el-select>
      <el-select v-model="list.filters.status" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="未检测" value="unknown" />
        <el-option label="可用" value="available" />
        <el-option label="不可用" value="unavailable" />
        <el-option label="已禁用" value="disabled" />
      </el-select>
      <el-select v-model="list.filters.enabled" placeholder="启用状态" clearable style="width: 120px" @change="list.search()">
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
      empty-title="还没有配置代理"
      empty-description="直连也可以正常采集；需要更换出口 IP 时再添加代理"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="代理" min-width="220">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-title">{{ row.name || proxyEndpoint(row) }}</span>
            <span class="wb-muted cell-sub wb-mono">
              {{ row.type }}://{{ row.host }}:{{ row.port }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="认证" width="160">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ row.username || '无需认证' }}</span>
            <span class="wb-muted cell-sub">
              <KeyRound :size="11" />
              {{ row.hasPassword ? '密码已配置' : '未设置密码' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <StatusTag :status="row.enabled ? row.status : 'disabled'" />
        </template>
      </el-table-column>

      <el-table-column label="最近测试" width="170">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ formatTime(row.lastTestAt) }}</span>
            <span v-if="row.lastTestStatus" class="wb-muted cell-sub">{{ row.lastTestStatus }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="使用统计" width="150">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ row.requestCount }} 次请求 · 成功率 {{ successRate(row) }}</span>
            <span class="wb-muted cell-sub">
              成功 {{ row.successCount }} / 失败 {{ row.failedCount }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="280" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text :loading="testingId === row.id" @click="runTest(row)">
              <Zap :size="13" />
              测试
            </el-button>
            <el-button size="small" text @click="openEdit(row)">
              <Pencil :size="13" />
              编辑
            </el-button>
            <el-button size="small" text @click="toggle(row)">{{ row.enabled ? '禁用' : '启用' }}</el-button>
            <el-button size="small" text type="danger" @click="askDelete(row)">
              <Trash2 :size="13" />
            </el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openCreate">新增代理</el-button>
      </template>
    </DataTable>

    <FormDialog
      v-model="dialogVisible"
      :title="editing ? `编辑代理 #${editing.id}` : '新增代理'"
      :loading="submitting"
      :width="560"
      description="密码写入后不可读取，只会保存在服务端的加密字段里。"
      @submit="submit"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="88px">
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="50" placeholder="可选，便于识别的备注名" />
        </el-form-item>
        <el-form-item label="协议">
          <el-radio-group v-model="form.type">
            <el-radio-button value="http">HTTP</el-radio-button>
            <el-radio-button value="https">HTTPS</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="主机" prop="host">
          <el-input v-model="form.host" placeholder="127.0.0.1 或 proxy.example.com" />
        </el-form-item>
        <el-form-item label="端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width: 160px" />
        </el-form-item>
        <el-form-item label="用户名">
          <el-input v-model="form.username" maxlength="100" placeholder="可选" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :disabled="form.clearPassword"
            :placeholder="editing?.hasPassword ? '留空表示不修改' : '可选'"
          />
          <el-checkbox v-if="editing?.hasPassword" v-model="form.clearPassword" class="pwd-clear">
            清除已保存的密码
          </el-checkbox>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
    </FormDialog>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除代理"
      :danger="true"
      :loading="deleteLoading"
      :confirm-text="deleteBlocked ? '解除引用并删除' : '删除'"
      @confirm="confirmDelete(Boolean(deleteBlocked))"
    >
      <p class="wb-secondary">{{ deleteTarget?.name || deleteTarget?.host }}</p>
      <p v-if="deleteBlocked" class="delete-blocked">
        {{ deleteBlocked }}
        <br />
        继续删除会把引用该代理的网站与栏目改回直连。
      </p>
      <p v-else class="wb-secondary">删除后不可恢复。</p>
    </ConfirmDialog>

    <el-dialog v-model="testVisible" title="代理连通性测试" width="560" align-center>
      <p class="test-target wb-mono">
        {{ testTarget?.type }}://{{ testTarget?.host }}:{{ testTarget?.port }}
      </p>

      <dl v-if="testResult" class="wb-kv">
        <dt>结果</dt>
        <dd>
          <StatusTag
            :status="testResult.ok ? 'available' : 'unavailable'"
            :label="testResult.ok ? '连通' : '不通'"
          />
        </dd>
        <dt>目标地址</dt>
        <dd class="wb-mono">{{ testResult.url }}</dd>
        <dt>HTTP 状态</dt>
        <dd>{{ testResult.statusCode ?? '—' }}</dd>
        <dt>耗时</dt>
        <dd>{{ testResult.elapsedMs }} ms</dd>
        <dt>说明</dt>
        <dd>{{ testResult.message }}</dd>
        <dt>测试时间</dt>
        <dd>{{ formatTime(testResult.testedAt) }}</dd>
      </dl>

      <div v-else-if="testError" class="test-error">
        <p>{{ testError }}</p>
        <p class="wb-muted">错误信息已脱敏，不会包含代理账号或密码。</p>
      </div>
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.pwd-clear {
  margin-top: 4px;
}

.delete-blocked {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--wb-warning);
  line-height: 1.7;
}

.test-target {
  font-size: 12.5px;
  color: var(--wb-text-secondary);
  margin-bottom: 10px;
}

.test-error {
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-danger-soft);
  font-size: 12.5px;
  color: var(--wb-text-secondary);
  line-height: 1.7;
}
</style>
