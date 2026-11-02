<script setup lang="ts">
/**
 * 插件管理。
 *
 * 只扫描本地插件目录里的 plugin.json 并登记，不联网、不下载、不安装。
 * 核心版本不兼容或清单解析失败的插件会逐条报错，但绝不会影响服务启动。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderSearch, RefreshCw, TriangleAlert } from '@lucide/vue'
import type {
  LogEntryDto,
  PluginDto,
  PluginErrorDto,
  PluginScanResultDto,
  PluginType,
} from '@webcrawler/shared'
import {
  getPlugin,
  listPluginErrors,
  listPlugins,
  refreshPlugins,
  scanPlugins,
  setPluginEnabled,
} from '@/api/plugins'
import { errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import JsonViewer from '@/components/common/JsonViewer.vue'
import LogViewer from '@/components/common/LogViewer.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const PLUGIN_TYPE_LABEL: Record<string, string> = {
  source: '数据源',
  parser: '解析器',
  exporter: '导出器',
  hook: '钩子',
}

const list = useListQuery<PluginDto, { keyword: string; type: string; enabled: string; status: string }>(
  (params) =>
    listPlugins({
      ...params,
      type: (params.type || undefined) as PluginType | undefined,
      enabled: (params.enabled || undefined) as 'true' | 'false' | undefined,
      status: (params.status || undefined) as PluginDto['status'] | undefined,
    }),
  { keyword: '', type: '', enabled: '', status: '' },
)

/* --------------------------------- 扫描 --------------------------------- */

const scanVisible = ref(false)
const scanning = ref(false)
const scanDirectory = ref('')
const scanResult = ref<PluginScanResultDto | null>(null)
const refreshing = ref(false)

function openScan(): void {
  scanDirectory.value = ''
  scanResult.value = null
  scanVisible.value = true
}

async function runScan(): Promise<void> {
  scanning.value = true
  try {
    scanResult.value = await scanPlugins(scanDirectory.value.trim() || undefined)
    const { added, updated, failed } = scanResult.value
    if (failed.length > 0) ElMessage.warning(`扫描完成：新增 ${added}、更新 ${updated}、失败 ${failed.length}`)
    else ElMessage.success(`扫描完成：新增 ${added}、更新 ${updated}`)
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    scanning.value = false
  }
}

async function runRefresh(): Promise<void> {
  refreshing.value = true
  try {
    const result = await refreshPlugins()
    if (result.failed.length > 0) ElMessage.warning(`已重建注册表，${result.failed.length} 个插件加载失败`)
    else ElMessage.success(`已重建注册表，注册 ${result.registered} 个插件`)
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    refreshing.value = false
  }
}

/* --------------------------------- 启停 --------------------------------- */

const togglingName = ref<string | null>(null)

async function toggle(row: PluginDto): Promise<void> {
  if (row.status === 'incompatible' || row.status === 'invalid') {
    ElMessage.warning('该插件不可用，请先修复清单或升级插件版本')
    return
  }
  togglingName.value = row.name
  try {
    await setPluginEnabled(row.name, !row.enabled)
    ElMessage.success(row.enabled ? '已停用插件' : '已启用插件')
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    togglingName.value = null
  }
}

/* --------------------------------- 详情 --------------------------------- */

const drawerVisible = ref(false)
const detail = ref<PluginDto | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const errors = ref<PluginErrorDto[]>([])
const errorsLoading = ref(false)

async function openDetail(row: PluginDto): Promise<void> {
  drawerVisible.value = true
  detail.value = null
  detailError.value = null
  errors.value = []
  detailLoading.value = true
  errorsLoading.value = true
  try {
    detail.value = await getPlugin(row.name)
  } catch (error) {
    detailError.value = errorMessage(error)
  } finally {
    detailLoading.value = false
  }
  try {
    const result = await listPluginErrors(row.name, 30)
    errors.value = result.items
  } catch {
    errors.value = []
  } finally {
    errorsLoading.value = false
  }
}

const detailConfig = computed(() => detail.value?.config ?? null)

/** 插件错误结构比日志少了任务/站点字段，这里补齐后复用同一个日志查看器。 */
const errorLogs = computed<LogEntryDto[]>(() =>
  errors.value.map((item) => ({
    id: item.id,
    taskId: null,
    siteId: null,
    categoryId: null,
    url: null,
    level: item.level as LogEntryDto['level'],
    stage: item.stage,
    message: item.message,
    detail: item.detail,
    createdAt: item.createdAt,
  })),
)

/* --------------------------------- 展示辅助 -------------------------------- */

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const scanFailed = computed(() => scanResult.value?.failed ?? [])
</script>

<template>
  <div class="view">
    <PageHeader
      title="插件管理"
      description="扫描本地插件目录并登记清单；第一版不做在线市场与自动安装。"
    >
      <template #actions>
        <el-button :loading="refreshing" @click="runRefresh">
          <RefreshCw :size="14" />
          <span>重建注册表</span>
        </el-button>
        <el-button type="primary" @click="openScan">
          <FolderSearch :size="14" />
          <span>扫描插件目录</span>
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索插件名称" @search="list.search()" />
      <el-select v-model="list.filters.type" placeholder="全部类型" clearable style="width: 130px" @change="list.search()">
        <el-option v-for="(label, value) in PLUGIN_TYPE_LABEL" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select v-model="list.filters.status" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="已启用" value="enabled" />
        <el-option label="已停用" value="disabled" />
        <el-option label="不兼容" value="incompatible" />
        <el-option label="加载失败" value="invalid" />
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
      row-key="name"
      empty-title="还没有登记插件"
      empty-description="把插件目录放进 plugins/ 后点击「扫描插件目录」"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="插件" min-width="210">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-title">{{ row.name }}</span>
            <span class="wb-muted cell-sub">
              {{ PLUGIN_TYPE_LABEL[row.type] ?? row.type }}
              · v{{ row.version }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="核心版本要求" width="140">
        <template #default="{ row }">
          <span class="wb-mono wb-muted">{{ row.coreVersion || '未声明' }}</span>
        </template>
      </el-table-column>

      <el-table-column label="入口" min-width="200">
        <template #default="{ row }">
          <span class="wb-mono cell-ellipsis">{{ row.entry || '—' }}</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <StatusTag :status="row.status" />
        </template>
      </el-table-column>

      <el-table-column label="更新时间" width="150">
        <template #default="{ row }">
          <span class="wb-muted">{{ formatTime(row.updatedAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text @click="openDetail(row)">详情</el-button>
            <el-button
              size="small"
              text
              :loading="togglingName === row.name"
              :disabled="row.status === 'incompatible' || row.status === 'invalid'"
              @click="toggle(row)"
            >
              {{ row.enabled ? '停用' : '启用' }}
            </el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openScan">扫描插件目录</el-button>
      </template>
    </DataTable>

    <!-- 扫描 -->
    <el-dialog v-model="scanVisible" title="扫描本地插件目录" width="600" align-center>
      <p class="dialog-desc">
        扫描会读取目录下每个子目录的 <code>plugin.json</code>，把清单登记到数据库并重建注册表。
        不会下载文件、不会执行插件代码。
      </p>
      <el-input
        v-model="scanDirectory"
        placeholder="留空使用服务端配置的插件目录（PLUGIN_DIR）"
        clearable
      >
        <template #prepend>目录</template>
      </el-input>

      <div v-if="scanResult" class="scan-result">
        <dl class="wb-kv">
          <dt>扫描时间</dt>
          <dd>{{ formatTime(scanResult.scannedAt) }}</dd>
          <dt>目录</dt>
          <dd class="wb-mono">{{ scanResult.directory }}</dd>
          <dt>目录存在</dt>
          <dd>{{ scanResult.exists ? '是' : '否（请先创建目录并放入插件）' }}</dd>
          <dt>发现清单</dt>
          <dd>{{ scanResult.found }} 个</dd>
          <dt>新增 / 更新</dt>
          <dd>{{ scanResult.added }} / {{ scanResult.updated }}</dd>
        </dl>

        <div v-if="scanFailed.length" class="scan-failed">
          <p class="scan-failed__title">
            <TriangleAlert :size="14" />
            {{ scanFailed.length }} 个插件未能登记
          </p>
          <ul>
            <li v-for="item in scanFailed" :key="item.name">
              <strong class="wb-mono">{{ item.name }}</strong>
              <span>{{ item.error }}</span>
            </li>
          </ul>
        </div>
      </div>

      <template #footer>
        <el-button :disabled="scanning" @click="scanVisible = false">关闭</el-button>
        <el-button type="primary" :loading="scanning" @click="runScan">开始扫描</el-button>
      </template>
    </el-dialog>

    <!-- 详情 -->
    <el-drawer v-model="drawerVisible" :title="detail?.name ?? '插件详情'" size="520px">
      <ErrorState
        v-if="detailError"
        compact
        :message="detailError"
        retry-text="关闭"
        @retry="drawerVisible = false"
      />
      <LoadingState v-else-if="detailLoading" :rows="5" />

      <template v-else-if="detail">
        <dl class="wb-kv">
          <dt>名称</dt>
          <dd class="wb-mono">{{ detail.name }}</dd>
          <dt>版本</dt>
          <dd>{{ detail.version }}</dd>
          <dt>类型</dt>
          <dd>{{ PLUGIN_TYPE_LABEL[detail.type] ?? detail.type }}</dd>
          <dt>核心版本要求</dt>
          <dd class="wb-mono">{{ detail.coreVersion || '未声明' }}</dd>
          <dt>入口</dt>
          <dd class="wb-mono">{{ detail.entry || '—' }}</dd>
          <dt>状态</dt>
          <dd><StatusTag :status="detail.status" /></dd>
          <dt>已注册</dt>
          <dd>{{ detail.registered ? '是' : '否' }}</dd>
          <dt>更新时间</dt>
          <dd>{{ formatTime(detail.updatedAt) }}</dd>
        </dl>

        <p v-if="detail.description" class="detail-desc">{{ detail.description }}</p>

        <p v-if="detail.error" class="detail-error">{{ detail.error }}</p>

        <h3 class="detail-title">清单配置</h3>
        <JsonViewer v-if="detailConfig" :value="detailConfig" :max-height="260" />
        <EmptyState v-else compact title="没有可展示的配置" />

        <h3 class="detail-title">错误日志</h3>
        <LoadingState v-if="errorsLoading" :rows="2" />
        <LogViewer v-else-if="errorLogs.length" :logs="errorLogs" :max-height="300" compact />
        <EmptyState v-else compact title="没有错误记录" description="插件加载与运行时错误会记录在这里" />
      </template>
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

.cell-ellipsis {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.row-actions {
  display: flex;
  gap: 2px;
}

.dialog-desc {
  font-size: 12.5px;
  color: var(--wb-text-muted);
  line-height: 1.7;
  margin-bottom: 10px;
}

.dialog-desc code {
  font-family: var(--wb-font-mono);
  background: var(--wb-surface-muted);
  padding: 1px 4px;
  border-radius: 4px;
}

.scan-result {
  margin-top: 14px;
}

.scan-failed {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-warning-soft);
}

.scan-failed__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--wb-warning);
}

.scan-failed ul {
  margin: 8px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}

.scan-failed li strong {
  display: block;
}

.detail-desc {
  margin-top: 12px;
  font-size: 13px;
  color: var(--wb-text-secondary);
  line-height: 1.75;
}

.detail-error {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-danger-soft);
  font-size: 12.5px;
  color: var(--wb-text-secondary);
  line-height: 1.7;
}

.detail-title {
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
}
</style>
