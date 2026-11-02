<script setup lang="ts">
/**
 * 任务详情。
 *
 * 进度条与计数全部读取服务端 `progress`；只要任务未结束就每 3 秒轮询一次，
 * 进入终态立刻停表。日志按 taskId 单独查询，与本页刷新互不影响。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft,
  Ban,
  CirclePause,
  CirclePlay,
  RefreshCw,
  RotateCcw,
  Trash2,
} from '@lucide/vue'
import type { CrawlTaskType, LogEntryDto, TaskDetailDto } from '@webcrawler/shared'
import {
  cancelTask,
  deleteTask,
  getTask,
  pauseTask,
  resumeTask,
  retryTask,
} from '@/api/tasks'
import { listLogs } from '@/api/logs'
import { errorMessage } from '@/api/client'
import { useAsyncState } from '@/composables/useAsyncState'
import { usePolling } from '@/composables/usePolling'
import PageHeader from '@/components/common/PageHeader.vue'
import StatCard from '@/components/common/StatCard.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import JsonViewer from '@/components/common/JsonViewer.vue'
import LogViewer from '@/components/common/LogViewer.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()

const taskId = computed(() => Number(route.params.id))

const TASK_TYPE_LABEL: Record<CrawlTaskType, string> = {
  site: '全站采集',
  category: '单栏目采集',
  batch: '批量栏目采集',
  urls: '指定 URL 采集',
  full: '全量采集',
  incremental: '增量采集',
}

const TASK_TRIGGER_LABEL = { manual: '手动创建', schedule: '定时调度', retry: '失败重试' } as const

const task = useAsyncState<TaskDetailDto>(() => getTask(taskId.value))

/** 未结束才需要轮询。 */
const isActive = computed(
  () => task.data.value?.status === 'pending' || task.data.value?.status === 'running',
)

const poller = usePolling(async () => {
  const current = await task.run()
  if (current && current.status !== 'pending' && current.status !== 'running') {
    poller.stop()
    void loadLogs()
  }
}, 3000)

watch(
  () => task.data.value?.status,
  (status) => {
    if (status === 'pending' || status === 'running') poller.start()
    else poller.stop()
  },
)

/* ---------------------------------- 日志 ---------------------------------- */

const logs = ref<LogEntryDto[]>([])
const logsLoading = ref(false)
const logsError = ref<string | null>(null)
const logLevel = ref<'' | 'debug' | 'info' | 'warn' | 'error'>('')

async function loadLogs(): Promise<void> {
  logsLoading.value = true
  logsError.value = null
  try {
    const page = await listLogs({
      taskId: taskId.value,
      pageSize: 100,
      level: (logLevel.value || undefined) as LogEntryDto['level'] | undefined,
    })
    logs.value = page.items
  } catch (error) {
    logsError.value = errorMessage(error)
    logs.value = []
  } finally {
    logsLoading.value = false
  }
}

watch(logLevel, () => void loadLogs())

const tab = ref<'snapshot' | 'checkpoint' | 'logs'>('snapshot')

watch(tab, (value) => {
  if (value === 'logs' && logs.value.length === 0 && !logsLoading.value) void loadLogs()
})

/* --------------------------------- 控制操作 -------------------------------- */

const acting = ref(false)
const deleteVisible = ref(false)

async function act(action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
  acting.value = true
  try {
    if (action === 'pause') await pauseTask(taskId.value)
    else if (action === 'resume') await resumeTask(taskId.value)
    else if (action === 'cancel') await cancelTask(taskId.value)
    else await retryTask(taskId.value)
    ElMessage.success(
      { pause: '已请求暂停', resume: '已恢复执行', cancel: '已取消任务', retry: '已重新入队' }[action],
    )
    await task.run()
    if (isActive.value) poller.start()
    void loadLogs()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    acting.value = false
  }
}

async function confirmDelete(): Promise<void> {
  acting.value = true
  try {
    await deleteTask(taskId.value)
    ElMessage.success('任务已删除')
    router.push('/tasks')
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    acting.value = false
    deleteVisible.value = false
  }
}

/* --------------------------------- 展示辅助 -------------------------------- */

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const duration = computed(() => {
  const data = task.data.value
  if (!data?.startedAt) return '—'
  const start = new Date(data.startedAt).getTime()
  const end = data.completedAt ? new Date(data.completedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
})

const progressStatus = computed(() => {
  const status = task.data.value?.status
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'exception'
  if (status === 'paused' || status === 'cancelled') return 'warning'
  return ''
})

const snapshot = computed(() => task.data.value?.configSnapshot ?? null)

onBeforeUnmount(() => poller.stop())

void loadLogs()
</script>

<template>
  <div class="view">
    <PageHeader
      :title="task.data.value?.name ?? `任务 #${taskId}`"
      :description="task.data.value ? `#${task.data.value.id} · ${TASK_TYPE_LABEL[task.data.value.type]} · ${TASK_TRIGGER_LABEL[task.data.value.trigger]} · ${task.data.value.siteName ?? '—'}` : '加载中…'"
    >
      <template #actions>
        <el-button @click="router.push('/tasks')">
          <ArrowLeft :size="14" />
          <span>返回列表</span>
        </el-button>
        <el-button :loading="task.loading.value" @click="task.run()">
          <RefreshCw :size="14" />
        </el-button>
        <template v-if="task.data.value">
          <el-button
            v-if="isActive"
            :loading="acting"
            @click="act('pause')"
          >
            <CirclePause :size="14" />
            <span>暂停</span>
          </el-button>
          <el-button v-if="task.data.value.status === 'paused'" :loading="acting" @click="act('resume')">
            <CirclePlay :size="14" />
            <span>恢复</span>
          </el-button>
          <el-button v-if="isActive || task.data.value.status === 'paused'" :loading="acting" @click="act('cancel')">
            <Ban :size="14" />
            <span>取消</span>
          </el-button>
          <el-button
            v-if="['failed', 'cancelled', 'completed'].includes(task.data.value.status)"
            type="primary"
            :loading="acting"
            @click="act('retry')"
          >
            <RotateCcw :size="14" />
            <span>重试</span>
          </el-button>
          <el-button type="danger" plain :loading="acting" @click="deleteVisible = true">
            <Trash2 :size="14" />
          </el-button>
        </template>
      </template>
    </PageHeader>

    <ErrorState v-if="task.error.value" :message="task.error.value" @retry="task.run()" />
    <LoadingState v-else-if="task.loading.value && !task.data.value" :rows="5" />

    <template v-else-if="task.data.value">
      <!-- 状态与进度 -->
      <section class="wb-card task-progress">
        <div class="task-progress__head">
          <div class="task-progress__status">
            <StatusTag :status="task.data.value.status" />
            <span v-if="isActive" class="task-progress__live">实时更新中</span>
            <span class="wb-muted">已运行 {{ duration }}</span>
          </div>
          <span class="task-progress__percent">{{ task.data.value.progress.percent }}%</span>
        </div>

        <el-progress
          :percentage="task.data.value.progress.percent"
          :status="progressStatus"
          :stroke-width="10"
        />

        <div class="stat-grid">
          <StatCard label="发现总数" :value="task.data.value.progress.total" tone="primary" />
          <StatCard label="采集成功" :value="task.data.value.progress.success" tone="success" />
          <StatCard label="采集失败" :value="task.data.value.progress.failed" tone="danger" />
          <StatCard label="跳过（已存在）" :value="task.data.value.progress.skipped" tone="neutral" />
        </div>

        <div v-if="task.data.value.errorSummary" class="task-error">
          <strong>失败原因</strong>
          <p>{{ task.data.value.errorSummary }}</p>
        </div>
      </section>

      <!-- 基本信息 -->
      <section class="wb-card">
        <h2 class="section-title">基本信息</h2>
        <dl class="wb-kv info-grid">
          <dt>任务 ID</dt>
          <dd class="wb-mono">{{ task.data.value.id }}</dd>
          <dt>状态</dt>
          <dd><StatusTag :status="task.data.value.status" /></dd>
          <dt>所属网站</dt>
          <dd>{{ task.data.value.siteName ?? `站点 #${task.data.value.siteId}` }}</dd>
          <dt>任务类型</dt>
          <dd>{{ TASK_TYPE_LABEL[task.data.value.type] }}</dd>
          <dt>触发方式</dt>
          <dd>{{ TASK_TRIGGER_LABEL[task.data.value.trigger] }}</dd>
          <dt>翻页进度</dt>
          <dd>
            {{ task.data.value.progress.currentPage }} / {{ task.data.value.progress.totalPages || '—' }} 页
          </dd>
          <dt>创建时间</dt>
          <dd>{{ formatTime(task.data.value.createdAt) }}</dd>
          <dt>开始时间</dt>
          <dd>{{ formatTime(task.data.value.startedAt) }}</dd>
          <dt>结束时间</dt>
          <dd>{{ formatTime(task.data.value.completedAt) }}</dd>
          <dt>尝试次数</dt>
          <dd>{{ task.data.value.attempts }}</dd>
        </dl>

        <div v-if="task.data.value.categories.length" class="category-list">
          <span class="wb-muted">涉及栏目</span>
          <div class="category-list__tags">
            <span v-for="item in task.data.value.categories" :key="item.id" class="wb-tag">{{ item.name }}</span>
          </div>
        </div>
      </section>

      <!-- 快照 / 断点 / 日志 -->
      <section class="wb-card">
        <div class="tab-bar">
          <button
            v-for="item in [
              { key: 'snapshot', label: '配置快照' },
              { key: 'checkpoint', label: '执行断点' },
              { key: 'logs', label: '执行日志' },
            ]"
            :key="item.key"
            type="button"
            class="tab-bar__item"
            :class="{ 'is-active': tab === item.key }"
            @click="tab = item.key as 'snapshot' | 'checkpoint' | 'logs'"
          >
            {{ item.label }}
          </button>
        </div>

        <div v-show="tab === 'snapshot'" class="tab-panel">
          <p class="wb-muted tab-panel__hint">
            快照是任务启动时固化的执行依据；之后修改规则或栏目不会影响本次任务。
          </p>
          <JsonViewer v-if="snapshot" :value="snapshot" :max-height="520" filename="task-snapshot.json" />
          <EmptyState v-else compact title="没有配置快照" description="任务尚未开始执行或快照已被清理" />
        </div>

        <div v-show="tab === 'checkpoint'" class="tab-panel">
          <p class="wb-muted tab-panel__hint">断点用于中断恢复：已完成的页码与已处理的 URL 会落盘。</p>
          <JsonViewer
            v-if="task.data.value.checkpoint"
            :value="task.data.value.checkpoint"
            :max-height="420"
            filename="task-checkpoint.json"
          />
          <EmptyState v-else compact title="暂无断点" description="任务处理完第一批数据后才会写入断点" />
        </div>

        <div v-show="tab === 'logs'" class="tab-panel">
          <div class="log-toolbar">
            <el-select v-model="logLevel" placeholder="全部级别" clearable style="width: 140px">
              <el-option label="DEBUG" value="debug" />
              <el-option label="INFO" value="info" />
              <el-option label="WARN" value="warn" />
              <el-option label="ERROR" value="error" />
            </el-select>
            <el-button :loading="logsLoading" @click="loadLogs()">
              <RefreshCw :size="14" />
              <span>刷新日志</span>
            </el-button>
            <el-button text @click="router.push(`/logs?taskId=${taskId}`)">在日志中心查看</el-button>
          </div>

          <ErrorState v-if="logsError" compact :message="logsError" @retry="loadLogs()" />
          <LoadingState v-else-if="logsLoading && logs.length === 0" :rows="3" />
          <LogViewer v-else :logs="logs" :max-height="480" />
        </div>
      </section>
    </template>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除任务"
      :danger="true"
      :loading="acting"
      confirm-text="删除"
      @confirm="confirmDelete"
    >
      <p class="wb-secondary">删除后任务记录与断点会被移除，已采集的文章保留。</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.task-progress {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
}

.task-progress__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-progress__status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  flex-wrap: wrap;
}

.task-progress__live {
  font-size: 12px;
  color: var(--wb-primary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.task-progress__live::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-primary);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.task-progress__percent {
  font-size: 20px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 900px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.task-error {
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-danger-soft);
  border: 1px solid var(--wb-danger-soft);
}

.task-error strong {
  font-size: 12.5px;
  color: var(--wb-danger);
}

.task-error p {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--wb-text-secondary);
  word-break: break-word;
}

.section-title {
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 10px;
}

.info-grid {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) 92px minmax(0, 1fr);
  gap: 8px 14px;
  font-size: 13px;
}

@media (max-width: 760px) {
  .info-grid {
    grid-template-columns: 92px minmax(0, 1fr);
  }
}

.info-grid dt {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}

.info-grid dd {
  color: var(--wb-text);
  word-break: break-word;
}

.category-list {
  margin-top: 14px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 12.5px;
}

.category-list__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--wb-border);
  margin-bottom: 12px;
}

.tab-bar__item {
  appearance: none;
  background: none;
  border: none;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--wb-text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.tab-bar__item.is-active {
  color: var(--wb-primary);
  border-bottom-color: var(--wb-primary);
  font-weight: 550;
}

.tab-panel__hint {
  font-size: 12.5px;
  margin-bottom: 8px;
}

.log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
</style>
