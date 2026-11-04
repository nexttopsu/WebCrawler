<script setup lang="ts">
/**
 * 插件管理。
 *
 * 插件是服务端源码的一部分：写在 `src/plugins/*.ts`，随进程启动注册一次。
 * 这里只做「看」和「启停」——没有扫描目录、没有重建注册表：
 * - 列表来自内置清单，元信息（名称 / 类型 / 支持位置）由源码决定，页面改不了；
 * - 启停直接作用于内存注册表并落库，立即生效，重启后保持。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshCw } from '@lucide/vue'
import type { LogEntryDto, PluginDto, PluginErrorDto, PluginType } from '@webcrawler/shared'
import { getPlugin, listPluginErrors, listPlugins, setPluginEnabled } from '@/api/plugins'
import { errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import LogViewer from '@/components/common/LogViewer.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const PLUGIN_TYPE_LABEL: Record<string, string> = {
  flow: '全流程',
  parser: '解析器',
}

const PLUGIN_SLOT_LABEL: Record<string, string> = {
  list: '列表',
  detail: '详情',
}

/** 插件能力来自实现的函数：getList / getDetail（全流程）、parseList / parseDetail（解析器）。 */
function slotText(plugin: PluginDto): string {
  const slots = plugin.slots ?? []
  if (plugin.type === 'parser') {
    if (slots.length === 0) return '字段后处理'
    return `字段后处理（${slots.map((slot) => PLUGIN_SLOT_LABEL[slot] ?? slot).join(' + ')}）`
  }
  return slots.length > 0 ? slots.map((slot) => PLUGIN_SLOT_LABEL[slot] ?? slot).join(' + ') : '未实现函数'
}

const list = useListQuery<PluginDto, { keyword: string; type: string; status: string; enabled: string }>(
  (params) =>
    listPlugins({
      ...params,
      type: (params.type || undefined) as PluginType | undefined,
      status: (params.status || undefined) as PluginDto['status'] | undefined,
      enabled: (params.enabled || undefined) as 'true' | 'false' | undefined,
    }),
  { keyword: '', type: '', status: '', enabled: '' },
)

/* --------------------------------- 启停 --------------------------------- */

const togglingId = ref<string | null>(null)

async function toggle(row: PluginDto): Promise<void> {
  if (row.status === 'invalid') {
    ElMessage.warning('该插件实现有问题，修好源码并重启服务后再启用')
    return
  }
  togglingId.value = row.pluginId
  try {
    await setPluginEnabled(row.pluginId, !row.enabled)
    ElMessage.success(row.enabled ? '已停用插件' : '已启用插件')
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    togglingId.value = null
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
    detail.value = await getPlugin(row.pluginId)
  } catch (error) {
    detailError.value = errorMessage(error)
  } finally {
    detailLoading.value = false
  }
  try {
    const result = await listPluginErrors(row.pluginId, 30)
    errors.value = result.items
  } catch {
    errors.value = []
  } finally {
    errorsLoading.value = false
  }
}

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
</script>

<template>
  <div class="view">
    <PageHeader
      title="插件管理"
      description="插件内置在服务端源码 src/plugins/ 里，随进程启动注册一次；改插件代码后重启服务生效。"
    >
      <template #actions>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
          <span>刷新</span>
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索插件 id / 名称" @search="list.search()" />
      <el-select v-model="list.filters.type" placeholder="全部类型" clearable style="width: 130px" @change="list.search()">
        <el-option v-for="(label, value) in PLUGIN_TYPE_LABEL" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select v-model="list.filters.status" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="已启用" value="enabled" />
        <el-option label="已停用" value="disabled" />
        <el-option label="实现有问题" value="invalid" />
      </el-select>
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      row-key="pluginId"
      empty-title="没有匹配的插件"
      empty-description="插件清单来自 src/plugins/index.ts，新增插件要在那里登记"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="插件" min-width="220">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-title">{{ row.name }}</span>
            <span class="wb-muted cell-sub">
              <code class="cell-id">{{ row.pluginId }}</code>
              · {{ PLUGIN_TYPE_LABEL[row.type] ?? row.type }}
              · v{{ row.version }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="支持位置" min-width="150">
        <template #default="{ row }">
          <span class="cell-ellipsis">{{ slotText(row) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="源码位置" min-width="260">
        <template #default="{ row }">
          <span class="wb-mono cell-ellipsis">{{ row.source }}</span>
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

      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text @click="openDetail(row)">详情</el-button>
            <el-button
              size="small"
              text
              :loading="togglingId === row.pluginId"
              :disabled="row.status === 'invalid'"
              @click="toggle(row)"
            >
              {{ row.enabled ? '停用' : '启用' }}
            </el-button>
          </div>
        </template>
      </el-table-column>
    </DataTable>

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
          <dt>插件 id</dt>
          <dd class="wb-mono">{{ detail.pluginId }}</dd>
          <dt>名称</dt>
          <dd>{{ detail.name }}</dd>
          <dt>版本</dt>
          <dd>{{ detail.version }}</dd>
          <dt>类型</dt>
          <dd>{{ PLUGIN_TYPE_LABEL[detail.type] ?? detail.type }}</dd>
          <dt>支持位置</dt>
          <dd>{{ slotText(detail) }}</dd>
          <dt>源码位置</dt>
          <dd class="wb-mono">{{ detail.source }}</dd>
          <dt>状态</dt>
          <dd><StatusTag :status="detail.status" /></dd>
          <dt>已注册</dt>
          <dd>{{ detail.registered ? '是' : '否（已停用）' }}</dd>
          <dt>更新时间</dt>
          <dd>{{ formatTime(detail.updatedAt) }}</dd>
        </dl>

        <p v-if="detail.description" class="detail-desc">{{ detail.description }}</p>

        <p v-if="detail.error" class="detail-error">{{ detail.error }}</p>

        <h3 class="detail-title">错误日志</h3>
        <LoadingState v-if="errorsLoading" :rows="2" />
        <LogViewer v-else-if="errorLogs.length" :logs="errorLogs" :max-height="300" compact />
        <EmptyState v-else compact title="没有错误记录" description="插件注册与运行时的错误会记录在这里" />
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

.cell-id {
  font-family: var(--wb-font-mono);
  font-size: 11px;
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
