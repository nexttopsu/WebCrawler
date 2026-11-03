<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Activity,
  ArrowRight,
  CalendarClock,
  FileText,
  FolderTree,
  Globe,
  Percent,
  PlugZap,
  RefreshCw,
} from '@lucide/vue'
import { fetchOverview } from '@/api/settings'
import { errorMessage } from '@/api/client'
import type { StatsOverviewDto } from '@webcrawler/shared'
import PageHeader from '@/components/common/PageHeader.vue'
import StatCard from '@/components/common/StatCard.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import TrendChart from '@/components/dashboard/TrendChart.vue'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const app = useAppStore()

const data = ref<StatsOverviewDto | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchOverview(14)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

const stats = computed(() => [
  {
    label: '网站总数',
    value: data.value?.counts.sites,
    hint: `${data.value?.counts.categories ?? 0} 个栏目`,
    icon: Globe,
    tone: 'primary' as const,
  },
  {
    label: '文章总数',
    value: data.value?.counts.articles,
    hint: `今日新增 ${data.value?.today.articles ?? 0} 篇`,
    icon: FileText,
    tone: 'success' as const,
  },
  {
    label: '今日采集',
    value: data.value?.today.articles,
    hint: `今日创建 ${data.value?.today.tasks ?? 0} 个任务`,
    icon: CalendarClock,
    tone: 'primary' as const,
  },
  {
    label: '正在执行',
    value: data.value?.running.tasks,
    hint: `${data.value?.running.pending ?? 0} 个排队中`,
    icon: Activity,
    tone: (data.value?.running.tasks ?? 0) > 0 ? ('warning' as const) : ('neutral' as const),
  },
  {
    label: '近 30 天成功率',
    value: data.value?.successRate === null || data.value?.successRate === undefined
      ? null
      : `${Math.round(data.value.successRate * 100)}%`,
    hint: `共 ${data.value?.counts.tasks ?? 0} 个任务`,
    icon: Percent,
    tone: 'success' as const,
  },
  {
    label: '代理可用',
    value: data.value ? `${data.value.proxies.available}/${data.value.proxies.total}` : null,
    hint: `${data.value?.proxies.unchecked ?? 0} 个未检测`,
    icon: PlugZap,
    tone: (data.value?.proxies.unavailable ?? 0) > 0 ? ('danger' as const) : ('neutral' as const),
  },
])

const hasData = computed(() => (data.value?.counts.articles ?? 0) + (data.value?.counts.tasks ?? 0) > 0)

const proxyRows = computed(() => {
  const proxies = data.value?.proxies
  if (!proxies) return []
  return [
    { label: '可用', value: proxies.available, tone: 'success' },
    { label: '不可用', value: proxies.unavailable, tone: 'danger' },
    { label: '未检测', value: proxies.unchecked, tone: 'neutral' },
  ]
})

function percent(value: number): number {
  const total = data.value?.proxies.total ?? 0
  if (total === 0) return 0
  return Math.round((value / total) * 100)
}

onMounted(() => {
  void load()
})

// 设置页保存后 bump 版本号，仪表盘随之刷新
watch(
  () => app.dataVersion,
  () => {
    void load()
  },
)
</script>

<template>
  <div class="dashboard">
    <PageHeader title="仪表盘" description="平台运行总览：采集量、任务状态与异常分布，数据全部来自真实接口。">
      <template #actions>
        <el-button :loading="loading" @click="load()">
          <RefreshCw :size="14" />
          <span>刷新</span>
        </el-button>
        <el-button type="primary" @click="router.push('/tasks')">
          <Activity :size="14" />
          <span>新建任务</span>
        </el-button>
      </template>
    </PageHeader>

    <ErrorState v-if="error" :message="error" @retry="load" />

    <template v-else>
      <div class="stat-grid">
        <StatCard
          v-for="item in stats"
          :key="item.label"
          :label="item.label"
          :value="item.value"
          :hint="item.hint"
          :icon="item.icon"
          :tone="item.tone"
          :loading="loading && !data"
        />
      </div>

      <div class="grid grid--trend">
        <section class="wb-card panel">
          <header class="panel__head">
            <div>
              <p class="panel__title">最近 14 天采集趋势</p>
              <p class="panel__hint">按本地日期聚合，含入库文章数与任务完成 / 失败数</p>
            </div>
            <RouterLink to="/articles" class="panel__link">
              查看文章
              <ArrowRight :size="13" />
            </RouterLink>
          </header>
          <TrendChart v-if="data" :points="data.trend" :loading="loading" />
          <EmptyState v-else compact title="暂无趋势数据" description="创建任务并完成一次采集后即可看到曲线" />
        </section>

        <section class="wb-card panel">
          <header class="panel__head">
            <div>
              <p class="panel__title">代理状态</p>
              <p class="panel__hint">
                共 {{ data?.proxies.total ?? 0 }} 个，启用 {{ data?.proxies.enabled ?? 0 }} 个
              </p>
            </div>
            <RouterLink to="/proxies" class="panel__link">
              去管理
              <ArrowRight :size="13" />
            </RouterLink>
          </header>

          <EmptyState
            v-if="!loading && (data?.proxies.total ?? 0) === 0"
            compact
            title="还没有配置代理"
            description="代理可选，直连也能采集"
          >
            <el-button size="small" type="primary" plain @click="router.push('/proxies')">新增代理</el-button>
          </EmptyState>

          <ul v-else class="proxy-list">
            <li v-for="row in proxyRows" :key="row.label" class="proxy-row">
              <span class="proxy-row__label">{{ row.label }}</span>
              <div class="proxy-row__bar">
                <span
                  class="proxy-row__fill"
                  :class="`is-${row.tone}`"
                  :style="{ width: `${percent(row.value)}%` }"
                />
              </div>
              <span class="proxy-row__value">{{ row.value }}</span>
            </li>
          </ul>
        </section>
      </div>

      <div class="grid grid--split">
        <section class="wb-card panel">
          <header class="panel__head">
            <p class="panel__title">最近任务</p>
            <RouterLink to="/tasks" class="panel__link">
              全部任务
              <ArrowRight :size="13" />
            </RouterLink>
          </header>

          <EmptyState v-if="!loading && (data?.recentTasks.length ?? 0) === 0" compact title="还没有任务" description="从「采集任务」创建第一个任务">
            <el-button size="small" type="primary" plain @click="router.push('/tasks')">创建任务</el-button>
          </EmptyState>

          <ul v-else class="task-list">
            <li v-for="task in data?.recentTasks" :key="task.id" class="task-row" @click="router.push(`/tasks/${task.id}`)">
              <div class="task-row__main">
                <span class="task-row__name">{{ task.name }}</span>
                <span class="task-row__meta wb-muted">
                  #{{ task.id }} · {{ task.siteName ?? '未知站点' }} ·
                  {{ task.progress.success }}/{{ task.progress.total }} 篇
                </span>
              </div>
              <div class="task-row__progress">
                <div class="task-row__bar">
                  <span :style="{ width: `${task.progress.percent}%` }" />
                </div>
                <StatusTag :status="task.status" />
              </div>
            </li>
          </ul>
        </section>

        <section class="wb-card panel">
          <header class="panel__head">
            <p class="panel__title">最近错误</p>
            <RouterLink to="/logs" class="panel__link">
              日志中心
              <ArrowRight :size="13" />
            </RouterLink>
          </header>

          <EmptyState v-if="!loading && (data?.recentErrors.length ?? 0) === 0" compact title="没有错误日志" description="采集正常运行时这里保持为空" />

          <ul v-else class="error-list">
            <li v-for="log in data?.recentErrors" :key="log.id" class="error-row">
              <StatusTag :status="log.level" :dot="false" />
              <div class="error-row__body">
                <p class="error-row__message">{{ log.message }}</p>
                <p class="error-row__meta wb-muted">
                  {{ log.stage }}
                  <template v-if="log.taskId"> · 任务 #{{ log.taskId }}</template>
                </p>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <p v-if="!hasData && !loading" class="dashboard__hint wb-muted">
        <FolderTree :size="14" />
        当前没有任何采集数据。先添加网站与栏目，再创建任务，仪表盘会自动更新。
      </p>
    </template>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.grid {
  display: grid;
  gap: 12px;
}

.grid--trend {
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
}

.grid--split {
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
}

.panel {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 160px;
}

.panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.panel__title {
  font-size: 14.5px;
  font-weight: 600;
}

.panel__hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.panel__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--wb-primary);
  white-space: nowrap;
}

.proxy-list,
.task-list,
.error-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.proxy-row {
  display: grid;
  grid-template-columns: 56px 1fr 36px;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  font-size: 12.5px;
}

.proxy-row__label {
  color: var(--wb-text-secondary);
}

.proxy-row__bar {
  height: 8px;
  border-radius: 999px;
  background: var(--wb-surface-muted);
  overflow: hidden;
}

.proxy-row__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--wb-text-muted);
  transition: width 0.4s ease;
}

.proxy-row__fill.is-success {
  background: var(--wb-success);
}
.proxy-row__fill.is-danger {
  background: var(--wb-danger);
}
.proxy-row__fill.is-neutral {
  background: var(--wb-text-muted);
}

.proxy-row__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--wb-text);
}

.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--wb-border);
  cursor: pointer;
}

.task-row:last-child {
  border-bottom: 0;
}

.task-row:hover .task-row__name {
  color: var(--wb-primary);
}

.task-row__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-row__name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-row__meta {
  font-size: 11.5px;
}

.task-row__progress {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.task-row__bar {
  width: 72px;
  height: 6px;
  border-radius: 999px;
  background: var(--wb-surface-muted);
  overflow: hidden;
}

.task-row__bar span {
  display: block;
  height: 100%;
  background: var(--wb-primary);
  border-radius: 999px;
}

.error-row {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--wb-border);
}

.error-row:last-child {
  border-bottom: 0;
}

.error-row__body {
  min-width: 0;
}

.error-row__message {
  font-size: 12.5px;
  color: var(--wb-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.error-row__meta {
  margin-top: 2px;
  font-size: 11.5px;
}

.dashboard__hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

@media (max-width: 1280px) {
  .stat-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .grid--trend,
  .grid--split {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
