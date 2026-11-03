<script setup lang="ts">
/**
 * 日志中心。
 *
 * 支持按任务 / 网站 / 级别 / 阶段 / 时间与关键词筛选；
 * 展开单行看 detail，错误信息可一键复制，任务列可直接跳到任务详情。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Copy, RefreshCw } from '@lucide/vue'
import type { LogEntryDto, SiteDto } from '@webcrawler/shared'
import { listLogs } from '@/api/logs'
import { listSites } from '@/api/sites'
import { useListQuery } from '@/composables/useListQuery'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'

const route = useRoute()
const router = useRouter()

const initialTaskId = Number(route.query.taskId ?? 0) || undefined

const list = useListQuery<
  LogEntryDto,
  {
    keyword: string
    taskId?: number
    siteId?: number
    level: string
    stage: string
    range: [string, string] | null
  }
>(
  (params) =>
    listLogs({
      page: params.page,
      pageSize: params.pageSize,
      keyword: params.keyword || undefined,
      taskId: params.taskId || undefined,
      siteId: params.siteId || undefined,
      level: (params.level || undefined) as LogEntryDto['level'] | undefined,
      stage: params.stage || undefined,
      from: params.range?.[0],
      to: params.range?.[1],
    }),
  { keyword: '', taskId: initialTaskId, siteId: undefined, level: '', stage: '', range: null },
)

const siteOptions = ref<SiteDto[]>([])

async function loadSites(): Promise<void> {
  try {
    const page = await listSites({ pageSize: 100 })
    siteOptions.value = page.items
  } catch {
    siteOptions.value = []
  }
}

/** 地址栏上带了 taskId 时，把筛选条件同步到输入框，避免用户看着空筛选却有结果。 */
watch(
  () => route.query.taskId,
  (value) => {
    const next = Number(value ?? 0) || undefined
    if (next !== list.filters.taskId) {
      list.filters.taskId = next
      list.search()
    }
  },
)

const STAGES = [
  'task',
  'schedule',
  'list',
  'request',
  'parse',
  'extract',
  'validate',
  'save',
  'plugin',
] as const

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

const errorCount = computed(() => list.rows.value.filter((row) => row.level === 'error').length)

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function copyLog(row: LogEntryDto): Promise<void> {
  const detail = row.detail ? `\n${JSON.stringify(row.detail, null, 2)}` : ''
  const text = `[${row.createdAt}] ${row.level.toUpperCase()} ${row.stage}\n${row.message}${detail}`
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制该条日志')
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问')
  }
}

void loadSites()
</script>

<template>
  <div class="view">
    <PageHeader title="日志中心" description="记录采集、调度与插件各阶段的运行信息；URL 与认证信息在写入前已脱敏。">
      <template #actions>
        <span v-if="errorCount" class="error-hint">{{ errorCount }} 条错误</span>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索日志内容" @search="list.search()" />
      <el-select
        v-model="list.filters.level"
        placeholder="全部级别"
        clearable
        style="width: 120px"
        @change="list.search()"
      >
        <el-option v-for="level in LEVELS" :key="level" :label="level.toUpperCase()" :value="level" />
      </el-select>
      <el-select
        v-model="list.filters.stage"
        placeholder="全部阶段"
        clearable
        style="width: 130px"
        @change="list.search()"
      >
        <el-option v-for="stage in STAGES" :key="stage" :label="stage" :value="stage" />
      </el-select>
      <el-select
        v-model="list.filters.siteId"
        placeholder="全部网站"
        clearable
        filterable
        style="width: 160px"
        @change="list.search()"
      >
        <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
      </el-select>
      <el-input
        v-model.number="list.filters.taskId"
        placeholder="任务 ID"
        clearable
        style="width: 110px"
        @keyup.enter="list.search()"
        @clear="list.search()"
      />
      <el-date-picker
        v-model="list.filters.range"
        type="datetimerange"
        value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
        style="width: 340px"
        @change="list.search()"
      />
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      :show-pagination="true"
      empty-title="没有匹配的日志"
      empty-description="调整筛选条件，或先运行一次采集任务"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="log-detail">
            <p v-if="row.url" class="log-detail__url wb-mono">{{ row.url }}</p>
            <pre v-if="row.detail" class="wb-code">{{ JSON.stringify(row.detail, null, 2) }}</pre>
            <p v-else class="wb-muted">该条日志没有附加信息</p>
            <div class="log-detail__actions">
              <el-button size="small" text @click="copyLog(row)">
                <Copy :size="13" />
                复制完整日志
              </el-button>
              <el-button size="small" text @click="router.push(`/logs?taskId=${row.taskId}`)">
                只看该任务日志
              </el-button>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="时间" width="160">
        <template #default="{ row }">
          <span class="wb-mono log-time">{{ formatTime(row.createdAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="级别" width="92">
        <template #default="{ row }">
          <StatusTag :status="row.level" :dot="false" />
        </template>
      </el-table-column>

      <el-table-column label="阶段" width="92">
        <template #default="{ row }">
          <span class="wb-tag">{{ row.stage }}</span>
        </template>
      </el-table-column>

      <el-table-column label="内容" min-width="320">
        <template #default="{ row }">
          <span class="log-message" :class="{ 'is-error': row.level === 'error' }">{{ row.message }}</span>
        </template>
      </el-table-column>

      <el-table-column label="任务" width="90">
        <template #default="{ row }">
          <button v-if="row.taskId" type="button" class="task-link" @click="router.push(`/tasks/${row.taskId}`)">
            #{{ row.taskId }}
          </button>
          <span v-else class="wb-muted">—</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="86" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text @click="copyLog(row)">
            <Copy :size="13" />
            复制
          </el-button>
        </template>
      </el-table-column>
    </DataTable>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.error-hint {
  font-size: 12.5px;
  color: var(--wb-danger);
}

.log-time {
  font-size: 12px;
  color: var(--wb-text-secondary);
}

.log-message {
  font-size: 12.5px;
  word-break: break-word;
}

.log-message.is-error {
  color: var(--wb-danger);
}

.task-link {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  font-size: 12.5px;
  color: var(--wb-primary);
  cursor: pointer;
}

.log-detail {
  padding: 8px 14px 12px 46px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-detail__url {
  font-size: 12px;
  color: var(--wb-text-secondary);
  word-break: break-all;
}

.log-detail__actions {
  display: flex;
  gap: 4px;
}
</style>
