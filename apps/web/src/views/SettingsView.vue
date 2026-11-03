<script setup lang="ts">
/**
 * 系统设置。
 *
 * 表单完全由服务端下发的 `items` 驱动：分组、控件类型、取值范围、生效方式都来自接口，
 * 前端不维护第二份键名清单，避免「界面能改但服务端不认」。
 * 只有真正改动过的项才会进入 PATCH，减少无意义写入。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, RotateCcw, Save } from '@lucide/vue'
import type {
  ProxyDto,
  SettingEffect,
  SettingGroup,
  SystemSettingItemDto,
  SystemSettingsDto,
} from '@webcrawler/shared'
import { fetchSettings, updateSettings } from '@/api/settings'
import { listProxies } from '@/api/proxies'
import { errorMessage } from '@/api/client'
import { useAsyncState } from '@/composables/useAsyncState'
import { useAppStore } from '@/stores/app'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'

const app = useAppStore()

const GROUP_LABEL: Record<SettingGroup, string> = {
  request: '请求默认值',
  task: '任务与调度',
  browser: '浏览器采集',
  log: '日志',
  system: '系统',
}

const GROUP_ORDER: SettingGroup[] = ['request', 'task', 'browser', 'log', 'system']

/** 时区下拉的常用候选；允许用户自己输入任意 IANA 名称。 */
const TIMEZONE_OPTIONS = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
]

const EFFECT_LABEL: Record<SettingEffect, string> = {
  immediate: '立即生效',
  'new-task': '新建任务生效',
  restart: '重启后生效',
  readonly: '只读',
}

const EFFECT_TONE: Record<SettingEffect, string> = {
  immediate: 'success',
  'new-task': 'info',
  restart: 'warning',
  readonly: 'neutral',
}

const settings = useAsyncState<SystemSettingsDto>(() => fetchSettings())

const form = reactive<Record<string, string | number | boolean | null>>({})
const original = ref<Record<string, string | number | boolean | null>>({})
const saving = ref(false)
const proxies = ref<ProxyDto[]>([])

const itemMap = computed(
  () => new Map((settings.data.value?.items ?? []).map((item) => [item.key, item])),
)

/**
 * 用接口返回值重置表单与基线。
 *
 * 控件值统一成「输入框能直接吃的形态」：数字控件存 number、开关存 boolean、
 * 下拉存 string（空串表示未设置），否则 el-select 拿 number 去匹配 string 选项会选不中。
 */
function hydrate(data: SystemSettingsDto): void {
  const next: Record<string, string | number | boolean | null> = {}
  for (const item of data.items) {
    if (item.control === 'number') next[item.key] = item.value === null ? null : Number(item.value)
    else if (item.control === 'switch') next[item.key] = Boolean(item.value)
    else next[item.key] = item.value === null || item.value === undefined ? '' : String(item.value)
  }
  Object.keys(form).forEach((key) => delete form[key])
  Object.assign(form, next)
  original.value = { ...next }
}

/** 把表单值还原成接口期望的类型。 */
function toPayload(key: string): string | number | boolean | null {
  const control = itemMap.value.get(key)?.control ?? 'text'
  const value = form[key]
  if (control === 'number') return value === null || value === '' ? null : Number(value)
  if (control === 'switch') return Boolean(value)
  if (control === 'proxy') return value === null || value === '' ? null : Number(value)
  return value === null || value === '' ? null : String(value)
}

watch(() => settings.data.value, (data) => { if (data) hydrate(data) }, { immediate: true })

const grouped = computed<Array<{ group: SettingGroup; label: string; items: SystemSettingItemDto[] }>>(() => {
  const items = settings.data.value?.items ?? []
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    items: items.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0)
})

/** 与基线不同的键。 */
const dirtyKeys = computed(() =>
  Object.keys(form).filter((key) => JSON.stringify(form[key]) !== JSON.stringify(original.value[key])),
)

const readonly = computed(() => settings.data.value?.readonly ?? null)

const proxyOptions = computed(() =>
  proxies.value.map((proxy) => ({
    label: `${proxy.name || proxy.host} · ${proxy.type}://${proxy.host}:${proxy.port}`,
    value: String(proxy.id),
  })),
)

const updatedAt = computed(() => {
  const value = settings.data.value?.updatedAt
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
})

function controlOptions(item: SystemSettingItemDto): Array<{ label: string; value: string }> {
  if (item.control === 'proxy') return [{ label: '不使用默认代理（直连）', value: '' }, ...proxyOptions.value]
  return item.options ?? []
}

async function save(): Promise<void> {
  if (dirtyKeys.value.length === 0) {
    ElMessage.info('没有需要保存的改动')
    return
  }
  const patch: Record<string, string | number | boolean | null> = {}
  for (const key of dirtyKeys.value) patch[key] = toPayload(key)

  saving.value = true
  try {
    const result = await updateSettings(patch)
    hydrate(result)
    app.bumpDataVersion()
    ElMessage.success(
      result.applied.length
        ? `已保存，${result.applied.length} 项立即生效`
        : '已保存，将在新建任务或重启后生效',
    )
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    saving.value = false
  }
}

function resetForm(): void {
  Object.assign(form, original.value)
}

async function loadProxies(): Promise<void> {
  try {
    const page = await listProxies({ pageSize: 100 })
    proxies.value = page.items
  } catch {
    proxies.value = []
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

void loadProxies()
</script>

<template>
  <div class="view">
    <PageHeader title="系统设置" description="这里的修改会直接作用到运行时；敏感配置（如代理密码）不会明文回显。">
      <template #actions>
        <el-button :disabled="dirtyKeys.length === 0" @click="resetForm">
          <RotateCcw :size="14" />
          <span>撤销改动</span>
        </el-button>
        <el-button type="primary" :loading="saving" :disabled="dirtyKeys.length === 0" @click="save">
          <Save :size="14" />
          <span>保存{{ dirtyKeys.length ? `（${dirtyKeys.length}）` : '' }}</span>
        </el-button>
      </template>
    </PageHeader>

    <ErrorState v-if="settings.error.value" :message="settings.error.value" @retry="settings.run()" />
    <LoadingState v-else-if="settings.loading.value && !settings.data.value" :rows="6" />

    <template v-else-if="settings.data.value">
      <!-- 只读运行信息 -->
      <section v-if="readonly" class="wb-card readonly-card">
        <div class="readonly-card__head">
          <h2 class="section-title">运行信息</h2>
          <span class="readonly-card__meta">最近保存：{{ updatedAt }}</span>
        </div>
        <dl class="wb-kv readonly-grid">
          <dt>版本</dt>
          <dd class="wb-mono">{{ readonly.version }}</dd>
          <dt>环境</dt>
          <dd>{{ readonly.env }}</dd>
          <dt>Node</dt>
          <dd class="wb-mono">{{ readonly.node }}</dd>
          <dt>平台</dt>
          <dd>{{ readonly.platform }}</dd>
          <dt>数据库</dt>
          <dd class="wb-mono">{{ readonly.databaseFile }}</dd>
          <dt>Schema 版本</dt>
          <dd>{{ readonly.schemaVersion }}</dd>
          <dt>运行时长</dt>
          <dd>{{ formatUptime(readonly.uptimeSeconds) }}</dd>
          <dt>系统时区</dt>
          <dd class="wb-mono">{{ readonly.systemTimeZone }}</dd>
          <dt>生效时区</dt>
          <dd class="wb-mono">{{ readonly.activeTimeZone }}</dd>
          <dt>代理密钥</dt>
          <dd>{{ readonly.proxySecretConfigured ? '已配置' : '未配置（使用内置密钥）' }}</dd>
        </dl>
      </section>

      <!-- 设置分组 -->
      <section v-for="entry in grouped" :key="entry.group" class="wb-card">
        <h2 class="section-title">{{ entry.label }}</h2>
        <div class="setting-list">
          <div v-for="item in entry.items" :key="item.key" class="setting-item">
            <div class="setting-item__label">
              <span class="setting-item__name">{{ item.label }}</span>
              <span class="setting-item__key wb-mono">{{ item.key }}</span>
            </div>

            <div class="setting-item__control">
              <el-input-number
                v-if="item.control === 'number'"
                :model-value="form[item.key] === null ? undefined : Number(form[item.key])"
                :min="item.min ?? 0"
                :max="item.max ?? 999999"
                :step="item.key.endsWith('Ms') ? 100 : 1"
                controls-position="right"
                style="width: 160px"
                @update:model-value="(value: number | undefined) => (form[item.key] = value ?? null)"
              />
              <span v-if="item.control === 'number' && item.unit" class="setting-item__unit">{{ item.unit }}</span>

              <el-switch
                v-else-if="item.control === 'switch'"
                :model-value="Boolean(form[item.key])"
                @update:model-value="(value: unknown) => (form[item.key] = Boolean(value))"
              />

              <el-select
                v-else-if="item.key === 'system.timezone'"
                :model-value="String(form[item.key] ?? '')"
                filterable
                allow-create
                default-first-option
                placeholder="留空则跟随系统时区"
                style="width: 240px"
                @update:model-value="(value: unknown) => (form[item.key] = value === undefined || value === null ? '' : String(value))"
              >
                <el-option label="跟随系统时区" value="" />
                <el-option v-for="zone in TIMEZONE_OPTIONS" :key="zone" :label="zone" :value="zone" />
              </el-select>

              <el-select
                v-else-if="item.control === 'select' || item.control === 'proxy'"
                :model-value="form[item.key] === null ? '' : String(form[item.key])"
                :placeholder="item.control === 'proxy' ? '不使用默认代理' : '请选择'"
                clearable
                style="width: 240px"
                @update:model-value="(value: unknown) => (form[item.key] = value === undefined || value === null ? '' : String(value))"
              >
                <el-option
                  v-for="option in controlOptions(item)"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>

              <el-input
                v-else
                :model-value="form[item.key] === null ? '' : String(form[item.key])"
                :disabled="!item.editable"
                :placeholder="item.defaultValue ? `默认：${item.defaultValue}` : '未设置'"
                style="width: 240px"
                @update:model-value="(value: string) => (form[item.key] = value)"
              />
            </div>

            <div class="setting-item__meta">
              <span class="effect-tag" :class="`is-${EFFECT_TONE[item.effect]}`">
                <Check :size="11" />
                {{ EFFECT_LABEL[item.effect] }}
              </span>
              <span class="setting-item__desc">{{ item.description }}</span>
              <span class="setting-item__default wb-muted">
                默认：{{ item.defaultValue === null || item.defaultValue === '' ? '未设置' : item.defaultValue }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <EmptyState
        v-if="grouped.length === 0"
        title="没有可编辑的设置项"
        description="服务端未下发任何设置项，请检查后端版本"
      />

      <p class="footnote">
        说明：只有白名单内的键可以修改，未知键会被服务端直接拒绝（400）。代理密码保存在代理管理中并加密存储，
        这里只能选择默认代理，不会返回任何密码明文。
      </p>
    </template>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.2px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--wb-border);
  margin-bottom: 4px;
}

.readonly-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.readonly-card__head .section-title {
  flex: 1;
  padding-bottom: 10px;
  margin-bottom: 0;
}

.readonly-card__meta {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.readonly-grid {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 88px minmax(0, 1fr);
  gap: 10px 16px;
  font-size: 13px;
  margin-top: 12px;
}

@media (max-width: 820px) {
  .readonly-grid {
    grid-template-columns: 88px minmax(0, 1fr);
  }
}

.readonly-grid dt {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}

.readonly-grid dd {
  word-break: break-all;
}

/*
 * 数据库路径最长，在 4 列栅格里会被从中间硬断成两截（webcr / awler.db）。
 * 让这一对独占整行，路径能完整读完。
 */
.readonly-grid dt:nth-of-type(5) {
  grid-column: 1;
}

.readonly-grid dt:nth-of-type(5) + dd {
  grid-column: 2 / -1;
}

.setting-list {
  display: flex;
  flex-direction: column;
}

.setting-item {
  display: grid;
  grid-template-columns: 220px 300px minmax(0, 1fr);
  align-items: center;
  gap: 8px 24px;
  padding: 14px 0;
  border-top: 1px dashed var(--wb-border);
}

.setting-item:first-child {
  border-top: none;
  padding-top: 12px;
}

@media (max-width: 1100px) {
  .setting-item {
    grid-template-columns: 1fr;
    align-items: flex-start;
  }
}

.setting-item__label {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.setting-item__name {
  font-size: 13px;
  font-weight: 500;
}

.setting-item__key {
  font-size: 11px;
  color: var(--wb-text-muted);
}

.setting-item__control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-item__unit {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.setting-item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.setting-item__desc {
  line-height: 1.6;
}

.setting-item__default {
  font-size: 11.5px;
}

.effect-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.effect-tag.is-success {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.effect-tag.is-info {
  background: var(--wb-info-soft);
  color: var(--wb-info);
}
.effect-tag.is-warning {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.effect-tag.is-neutral {
  background: var(--wb-neutral-soft);
  color: var(--wb-neutral);
}

.footnote {
  font-size: 12px;
  color: var(--wb-text-muted);
  line-height: 1.8;
  padding: 0 2px 8px;
}

/* 卡片已有内边距，这里只留下说明文字的呼吸空间 */
@media (max-width: 1100px) {
  .setting-item {
    gap: 10px;
  }

  .setting-item__control :deep(.el-input-number),
  .setting-item__control :deep(.el-select),
  .setting-item__control :deep(.el-input) {
    width: 100% !important;
    max-width: 320px;
  }
}
</style>
