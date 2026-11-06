<script setup lang="ts">
/**
 * 采集任务列表。
 *
 * 进度全部来自后端 `progress`，前端只负责展示；
 * 列表里只要还有 pending / running 的任务就每 5 秒刷新一次，全部结束后自动停表。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance } from 'element-plus'
import {
  Ban,
  CirclePause,
  CirclePlay,
  Eye,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from '@lucide/vue'
import type {
  CrawlTaskStatus,
  CrawlTaskType,
  SiteDto,
  TaskDto,
} from '@webcrawler/shared'
import {
  cancelTask,
  createTask,
  deleteTask,
  listTasks,
  pauseTask,
  resumeTask,
  retryTask,
} from '@/api/tasks'
import { listSites } from '@/api/sites'
import { errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import { useCategoryTree } from '@/composables/useCategoryTree'
import { usePolling } from '@/composables/usePolling'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import CategorySelect from '@/components/common/CategorySelect.vue'

const router = useRouter()

const TASK_TYPE_LABEL: Record<CrawlTaskType, string> = {
  site: '全站',
  category: '单栏目',
  batch: '批量栏目',
  urls: '指定 URL',
  full: '全量',
  incremental: '增量',
  list: '仅列表',
  detail: '详情补采',
}

const TASK_TRIGGER_LABEL = {
  manual: '手动',
  schedule: '定时',
  retry: '重试',
} as const

const list = useListQuery<TaskDto, { keyword: string; status: string; type: string; siteId?: number }>(
  (params) =>
    listTasks({
      ...params,
      status: (params.status || undefined) as CrawlTaskStatus | undefined,
      type: (params.type || undefined) as CrawlTaskType | undefined,
      siteId: params.siteId || undefined,
    }),
  { keyword: '', status: '', type: '', siteId: undefined },
)

const siteOptions = ref<SiteDto[]>([])
const siteNameMap = computed(() => new Map(siteOptions.value.map((site) => [site.id, site.name])))

/** 有未结束的任务才轮询，避免空闲时无意义地打接口。 */
const hasActive = computed(() =>
  list.rows.value.some((row) => row.status === 'pending' || row.status === 'running'),
)
const poller = usePolling(() => list.load(), 5000)

watch(hasActive, (active) => {
  if (active) poller.start()
  else poller.stop()
})

onMounted(async () => {
  if (hasActive.value) poller.start()
  try {
    const sites = await listSites({ pageSize: 100 })
    siteOptions.value = sites.items
  } catch {
    siteOptions.value = []
  }
})

/* -------------------------------- 创建任务 -------------------------------- */

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const { categorySiteMap } = useCategoryTree()

const form = reactive({
  categoryIds: [] as number[],
  name: '',
  startPage: 1,
  endPage: 0,
  retries: 2,
  rateLimitMs: 100,
  incremental: false,
  /** 采集范围：仅列表 / 列表 + 详情 */
  collectScope: 'list' as 'full' | 'list',
})

/** 选中栏目后锁定到该站点：选择器只列同站栏目，siteId 也由栏目反推。 */
const selectedSiteId = computed(() => {
  const first = form.categoryIds[0]
  return first !== undefined ? (categorySiteMap.value.get(first) ?? null) : null
})

function openCreate(): void {
  Object.assign(form, {
    categoryIds: [],
    name: '',
    startPage: 1,
    endPage: 0,
    retries: 2,
    rateLimitMs: 100,
    incremental: false,
    collectScope: 'list',
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  if (form.categoryIds.length === 0) {
    ElMessage.warning('请至少选择一个栏目')
    return
  }
  const siteId = selectedSiteId.value
  if (!siteId) {
    ElMessage.warning('无法确定所选栏目的所属网站，请重新选择')
    return
  }
  if (form.endPage > 0 && form.endPage < form.startPage) {
    ElMessage.warning('结束分页不能小于开始分页')
    return
  }

  const options: Record<string, unknown> = {
    retries: form.retries,
    collectScope: form.collectScope,
  }
  if (form.startPage > 1) options.startPage = form.startPage
  if (form.endPage > 0) options.endPage = form.endPage
  if (form.rateLimitMs > 0) options.rateLimitMs = form.rateLimitMs
  if (form.incremental) options.incremental = true

  submitting.value = true
  try {
    // 单选是「单栏目」任务，多选自动升级为「批量栏目」任务
    const task = await createTask({
      name: form.name.trim() || undefined,
      siteId,
      type: form.categoryIds.length > 1 ? 'batch' : 'category',
      categoryIds: form.categoryIds,
      options,
    })
    ElMessage.success(`任务 #${task.id} 已创建`)
    dialogVisible.value = false
    router.push(`/tasks/${task.id}`)
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

/* -------------------------------- 行内控制 -------------------------------- */

const actingId = ref<number | null>(null)

async function act(row: TaskDto, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
  actingId.value = row.id
  try {
    if (action === 'pause') await pauseTask(row.id)
    else if (action === 'resume') await resumeTask(row.id)
    else if (action === 'cancel') await cancelTask(row.id)
    else await retryTask(row.id)
    ElMessage.success(
      { pause: '已请求暂停', resume: '已恢复执行', cancel: '已取消任务', retry: '已重新入队' }[action],
    )
    await list.load()
    if (hasActive.value) poller.start()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    actingId.value = null
  }
}

const deleteVisible = ref(false)
const deleteTarget = ref<TaskDto | null>(null)
const deleteLoading = ref(false)

function askDelete(row: TaskDto): void {
  deleteTarget.value = row
  deleteVisible.value = true
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await deleteTask(deleteTarget.value.id)
    ElMessage.success('任务已删除')
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

/* -------------------------------- 展示辅助 -------------------------------- */

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function progressStatus(status: CrawlTaskStatus): '' | 'success' | 'exception' | 'warning' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'exception'
  if (status === 'paused' || status === 'cancelled') return 'warning'
  return ''
}
</script>

<template>
  <div class="view">
    <PageHeader title="采集任务" description="任务在后台独立执行，可以暂停、恢复或取消；进度均来自服务端真实状态。">
      <template #actions>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          <span>新建任务</span>
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索任务名称" @search="list.search()" />
      <el-select v-model="list.filters.status" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="排队中" value="pending" />
        <el-option label="执行中" value="running" />
        <el-option label="已暂停" value="paused" />
        <el-option label="已完成" value="completed" />
        <el-option label="失败" value="failed" />
        <el-option label="已取消" value="cancelled" />
      </el-select>
      <el-select v-model="list.filters.type" placeholder="全部类型" clearable style="width: 130px" @change="list.search()">
        <el-option v-for="(label, value) in TASK_TYPE_LABEL" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select
        v-model="list.filters.siteId"
        placeholder="全部网站"
        clearable
        filterable
        style="width: 180px"
        @change="list.search()"
      >
        <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
      </el-select>
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      empty-title="还没有任务"
      empty-description="可以按栏目、指定 URL 或整站创建采集任务"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="任务" min-width="200">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-title">{{ row.name }}</span>
            <span class="wb-muted cell-sub">
              #{{ row.id }} · {{ TASK_TYPE_LABEL[row.type as CrawlTaskType] }}
              · {{ TASK_TRIGGER_LABEL[row.trigger as keyof typeof TASK_TRIGGER_LABEL] }}
              · {{ row.siteName ?? siteNameMap.get(row.siteId) ?? `站点 #${row.siteId}` }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="104">
        <template #default="{ row }">
          <StatusTag :status="row.status" />
        </template>
      </el-table-column>

      <el-table-column label="进度" min-width="190">
        <template #default="{ row }">
          <div class="progress-cell">
            <el-progress
              :percentage="row.progress.percent"
              :status="progressStatus(row.status)"
              :stroke-width="6"
              :show-text="false"
            />
            <span class="wb-muted progress-cell__text">
              {{ row.progress.percent }}% · 成功 {{ row.progress.success }} / 失败
              {{ row.progress.failed }} / 跳过 {{ row.progress.skipped }}
              <template v-if="row.progress.totalPages > 0">
                · 第 {{ row.progress.currentPage }}/{{ row.progress.totalPages }} 页
              </template>
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="时间" width="150">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ formatTime(row.startedAt ?? row.createdAt) }}</span>
            <span v-if="row.completedAt" class="wb-muted cell-sub">完成 {{ formatTime(row.completedAt) }}</span>
            <span v-else-if="row.errorSummary" class="cell-error cell-sub">{{ row.errorSummary }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text @click="router.push(`/tasks/${row.id}`)">
              <Eye :size="13" />
              详情
            </el-button>
            <el-button
              v-if="row.status === 'running' || row.status === 'pending'"
              size="small"
              text
              :loading="actingId === row.id"
              @click="act(row, 'pause')"
            >
              <CirclePause :size="13" />
              暂停
            </el-button>
            <el-button
              v-if="row.status === 'paused'"
              size="small"
              text
              :loading="actingId === row.id"
              @click="act(row, 'resume')"
            >
              <CirclePlay :size="13" />
              恢复
            </el-button>
            <el-button
              v-if="row.status === 'running' || row.status === 'pending' || row.status === 'paused'"
              size="small"
              text
              :loading="actingId === row.id"
              @click="act(row, 'cancel')"
            >
              <Ban :size="13" />
              取消
            </el-button>
            <el-button
              v-if="row.status === 'failed' || row.status === 'cancelled' || row.status === 'completed'"
              size="small"
              text
              :loading="actingId === row.id"
              @click="act(row, 'retry')"
            >
              <RotateCcw :size="13" />
              重试
            </el-button>
            <el-button size="small" text type="danger" @click="askDelete(row)">
              <Trash2 :size="13" />
            </el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" size="small" @click="openCreate">新建任务</el-button>
      </template>
    </DataTable>

    <FormDialog
      v-model="dialogVisible"
      title="新建采集任务"
      :loading="submitting"
      :width="640"
      description="任务创建后立即排队执行，执行依据是创建时固化的规则快照，之后修改规则不影响它。"
      @submit="submit"
    >
      <el-form ref="formRef" :model="form" label-width="92px">
        <el-form-item label="采集范围">
          <el-radio-group v-model="form.collectScope">
            <el-radio-button value="list">仅列表</el-radio-button>
            <el-radio-button value="full">列表 + 详情</el-radio-button>
          </el-radio-group>
          <p class="form-hint">
            {{
              form.collectScope === 'list'
                ? '只抓列表页并入库（标题 + 链接），文章详情状态记为「详情待采」，之后可在文章页单篇或批量补采。'
                : '抓取列表页后逐篇采集文章详情。'
            }}
          </p>
        </el-form-item>

        <el-form-item
          label="所属栏目"
          :rules="[{ required: true, message: '请选择要采集的栏目' }]"
          prop="categoryIds"
        >
          <CategorySelect
            v-model="form.categoryIds"
            :site-id="selectedSiteId"
            multiple
            only-enabled
            placeholder="选择要采集的栏目，可多选"
            no-data-text="还没有启用的栏目，请先到栏目管理中创建"
          />
          <p class="form-hint">选定栏目后即确定网站归属，之后只能选同一网站下的栏目；多选会按顺序依次采集。</p>
        </el-form-item>

        <el-form-item label="任务名称">
          <el-input v-model="form.name" maxlength="60" placeholder="可选，留空自动生成" />
        </el-form-item>

        <el-collapse class="form-advanced">
          <el-collapse-item name="options" title="执行参数（可选）">
            <div class="option-grid">
              <label class="option-item">
                <span>开始分页</span>
                <el-input-number v-model="form.startPage" :min="1" :step="1" controls-position="right" />
                <small>从第几页开始抓</small>
              </label>
              <label class="option-item">
                <span>结束分页</span>
                <el-input-number v-model="form.endPage" :min="0" :step="1" controls-position="right" />
                <small>0 表示只抓 1 页</small>
              </label>
              <label class="option-item">
                <span>单篇重试</span>
                <el-input-number v-model="form.retries" :min="0" :max="5" controls-position="right" />
                <small>不含首次请求</small>
              </label>
              <label class="option-item">
                <span>请求间隔 (ms)</span>
                <el-input-number v-model="form.rateLimitMs" :min="0" :step="100" controls-position="right" />
                <small>0 用系统默认</small>
              </label>
            </div>

            <div class="option-switches">
              <el-checkbox v-model="form.incremental">跳过已采集 URL</el-checkbox>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-form>
    </FormDialog>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除任务"
      :danger="true"
      :loading="deleteLoading"
      confirm-text="删除"
      @confirm="confirmDelete"
    >
      <p class="wb-secondary">{{ deleteTarget?.name }}（#{{ deleteTarget?.id }}）</p>
      <p class="wb-secondary">已采集的文章会保留，只删除任务记录与日志关联。</p>
    </ConfirmDialog>
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

.cell-error {
  color: var(--wb-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.progress-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.progress-cell__text {
  font-size: 11.5px;
  line-height: 1.5;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.form-advanced {
  margin-top: 4px;
  border-top: 1px solid var(--wb-border);
  border-bottom: none;
}

.option-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.option-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--wb-text-secondary);
}

.option-item small {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.option-switches {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 4px;
  padding-left: 2px;
}
</style>
