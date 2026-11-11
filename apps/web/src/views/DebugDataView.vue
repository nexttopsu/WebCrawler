<script setup lang="ts">
/**
 * 调试数据。
 *
 * 按网址存档响应原文：采集任务与规则测试器在发请求前先查这里，
 * **网址完全相等**时直接返回 raw，不再访问目标站点 —— 用来离线复现、
 * 或在站点改版 / 下线后继续调规则。
 *
 * 列表刻意不展示 raw（动辄几百 KB），只在「查看 / 编辑」时单独读取；
 * 删除与「可覆盖」的批量修改都支持勾选批量与按筛选条件批量，语义一致。
 * 「可覆盖」控制捕获浏览器：关掉后再次访问该网址不会冲掉手工整理的存档。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Check, CircleStop, Copy, Eye, Globe, Lock, Pencil, Plus, RefreshCw, Trash2, Unlock } from '@lucide/vue'
import type {
  DebugCaptureStatusDto,
  DebugContentType,
  DebugSampleDetailDto,
  DebugSampleDto,
} from '@webcrawler/shared'
import {
  createDebugSample,
  deleteDebugSample,
  deleteDebugSamples,
  getDebugCaptureStatus,
  getDebugSample,
  listDebugSamples,
  setDebugSamplesOverridable,
  startDebugCapture,
  stopDebugCapture,
  updateDebugSample,
} from '@/api/debug-data'
import { errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import { usePolling } from '@/composables/usePolling'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

/** raw 上限与服务端保持一致（20 MB）。 */
const RAW_MAX_BYTES = 20 * 1024 * 1024

/** 查看时最多渲染的字符数：原文可能几百 KB，全量塞进 pre 会卡住页面。 */
const RAW_PREVIEW_CHARS = 200_000

const CONTENT_TYPES: Array<{ value: DebugContentType; label: string }> = [
  { value: 'html', label: 'HTML' },
  { value: 'json', label: 'JSON' },
]

const list = useListQuery<DebugSampleDto, { keyword: string; contentType: string; overridable: string }>(
  (params) =>
    listDebugSamples({
      page: params.page,
      pageSize: params.pageSize,
      keyword: params.keyword || undefined,
      contentType: (params.contentType || undefined) as DebugContentType | undefined,
      overridable: (params.overridable || undefined) as 'true' | 'false' | undefined,
    }),
  { keyword: '', contentType: '', overridable: '' },
)

/* ------------------------------- 捕获浏览器 ------------------------------- */

/**
 * 捕获浏览器在**后端所在的机器**上打开：用户在这个窗口里正常浏览，
 * 每个网页的响应原文都会写进调试库，列表随状态轮询自动刷新。
 * 关窗口即停止（后端监听 context close），也可以点「停止浏览器」显式结束。
 */
const capture = ref<DebugCaptureStatusDto | null>(null)
const captureRunning = computed(() => capture.value?.state === 'running')
const captureStarting = ref(false)
const captureStopping = ref(false)
const captureDialogVisible = ref(false)

const captureForm = reactive({
  startUrl: '',
  includeJson: false,
  headless: false,
})

/** 状态轮询：2s 一次，捕获数变化才刷新列表，停止后自动停表。 */
const capturePolling = usePolling(async () => {
  try {
    const next = await getDebugCaptureStatus()
    const previous = capture.value
    capture.value = next
    if (!previous || next.captured !== previous.captured) await list.load()
    if (next.state !== 'running') capturePolling.stop()
  } catch {
    // 轮询失败不打扰用户，下一轮再试
  }
}, 2000)

async function refreshCaptureStatus(): Promise<void> {
  try {
    capture.value = await getDebugCaptureStatus()
    if (capture.value.state === 'running') capturePolling.start()
  } catch {
    // 状态接口失败不阻塞列表页
  }
}

onMounted(() => {
  void refreshCaptureStatus()
})

function openCaptureDialog(): void {
  captureForm.startUrl = ''
  captureForm.includeJson = false
  captureForm.headless = false
  captureDialogVisible.value = true
}

async function submitCapture(): Promise<void> {
  const startUrl = captureForm.startUrl.trim()
  if (startUrl && !/^https?:\/\//i.test(startUrl)) {
    ElMessage.warning('起始网址必须以 http:// 或 https:// 开头')
    return
  }

  captureStarting.value = true
  try {
    capture.value = await startDebugCapture({
      startUrl: startUrl || null,
      includeJson: captureForm.includeJson,
      headless: captureForm.headless,
    })
    captureDialogVisible.value = false
    ElMessage.success('浏览器已启动：在这个窗口里访问的网页会自动写入调试库')
    capturePolling.start()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    captureStarting.value = false
  }
}

async function stopCapture(): Promise<void> {
  captureStopping.value = true
  try {
    capture.value = await stopDebugCapture()
    capturePolling.stop()
    ElMessage.success(`已停止浏览器：本次记录 ${capture.value.captured} 个页面`)
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    captureStopping.value = false
  }
}

/** 捕获栏的标题：只在有会话（运行中 / 已停止）时出现。 */
const captureTitle = computed(() => {
  if (!capture.value) return ''
  if (capture.value.state === 'running') return '捕获浏览器运行中'
  if (capture.value.state === 'stopped') return '上次捕获已停止'
  return '捕获浏览器异常'
})

const captureVisible = computed(() => Boolean(capture.value && capture.value.state !== 'idle'))

/* ------------------------------- 勾选与批量 ------------------------------- */

const selection = ref<DebugSampleDto[]>([])

function onSelectionChange(rows: unknown[]): void {
  selection.value = rows as DebugSampleDto[]
}

/** 有勾选就按勾选删，否则按当前筛选条件删；两者都没有时按钮禁用。 */
const batchMode = computed<'selection' | 'filters' | null>(() => {
  if (selection.value.length > 0) return 'selection'
  if (list.isFiltered()) return 'filters'
  return null
})

const batchCount = computed(() =>
  batchMode.value === 'selection' ? selection.value.length : list.total.value,
)

/** 把当前筛选条件翻译成人话，放进二次确认弹窗。 */
const filterText = computed(() => {
  const parts: string[] = []
  const { keyword, contentType, overridable } = list.filters
  if (keyword) parts.push(`关键词「${keyword}」`)
  if (contentType) parts.push(`类型 ${contentType.toUpperCase()}`)
  if (overridable) parts.push(overridable === 'true' ? '可覆盖' : '不可覆盖')
  return parts.join('、') || '（未设置条件）'
})

/* ------------------------------- 新建 / 编辑 ------------------------------- */

const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const loadingDetail = ref(false)
const formRef = ref<FormInstance>()

const draftForm = reactive({
  url: '',
  raw: '',
  statusCode: 200,
  contentType: 'html' as DebugContentType,
  note: '',
  overridable: true,
})

const rules: FormRules = {
  url: [
    { required: true, message: '请填写完整网址', trigger: 'blur' },
    {
      pattern: /^https?:\/\//i,
      message: '网址必须以 http:// 或 https:// 开头',
      trigger: 'blur',
    },
  ],
  raw: [{ required: true, message: 'raw 不能为空', trigger: 'blur' }],
}

/** 表单里 raw 的字节数：超过服务端上限时提前提示，不让用户白等一次请求。 */
const rawBytes = computed(() => new TextEncoder().encode(draftForm.raw).length)

function resetForm(): void {
  Object.assign(draftForm, {
    url: '',
    raw: '',
    statusCode: 200,
    contentType: 'html',
    note: '',
    overridable: true,
  })
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  // 从测试器带过来的网址（/debug-data?url=...）直接填上，省一次复制粘贴
  const preset = new URLSearchParams(window.location.search).get('url')
  if (preset) draftForm.url = preset
  dialogVisible.value = true
}

async function openEdit(row: DebugSampleDto): Promise<void> {
  editingId.value = row.id
  resetForm()
  dialogVisible.value = true
  loadingDetail.value = true
  try {
    const detail = await getDebugSample(row.id)
    Object.assign(draftForm, {
      url: detail.url,
      raw: detail.raw,
      statusCode: detail.statusCode,
      contentType: detail.contentType,
      note: detail.note ?? '',
      overridable: detail.overridable,
    })
  } catch (error) {
    ElMessage.error(errorMessage(error))
    dialogVisible.value = false
  } finally {
    loadingDetail.value = false
  }
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (rawBytes.value > RAW_MAX_BYTES) {
    ElMessage.error('raw 超过 20 MB 上限，请拆分后再保存')
    return
  }

  submitting.value = true
  try {
    const payload = {
      url: draftForm.url.trim(),
      raw: draftForm.raw,
      statusCode: draftForm.statusCode,
      contentType: draftForm.contentType,
      note: draftForm.note.trim() || null,
      overridable: draftForm.overridable,
    }
    if (editingId.value) {
      await updateDebugSample(editingId.value, payload)
      ElMessage.success('调试数据已更新')
    } else {
      await createDebugSample(payload)
      ElMessage.success('调试数据已新增')
    }
    dialogVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

/* --------------------------------- 查看 --------------------------------- */

const viewVisible = ref(false)
const viewLoading = ref(false)
const detail = ref<DebugSampleDetailDto | null>(null)

async function openView(row: DebugSampleDto): Promise<void> {
  viewVisible.value = true
  viewLoading.value = true
  detail.value = null
  try {
    detail.value = await getDebugSample(row.id)
  } catch (error) {
    ElMessage.error(errorMessage(error))
    viewVisible.value = false
  } finally {
    viewLoading.value = false
  }
}

/** 超长原文只渲染前 200K 字符，其余提示去复制/下载。 */
const rawPreview = computed(() => {
  const raw = detail.value?.raw ?? ''
  if (raw.length <= RAW_PREVIEW_CHARS) return { text: raw, truncated: false }
  return { text: raw.slice(0, RAW_PREVIEW_CHARS), truncated: true }
})

async function copyRaw(): Promise<void> {
  try {
    await navigator.clipboard.writeText(detail.value?.raw ?? '')
    ElMessage.success('已复制 raw')
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问')
  }
}

/* ------------------------------- 复制网址 ------------------------------- */

/** 列表行「复制网址」按钮：成功后短暂换成 ✓，与接口文档页的反馈一致。 */
const copiedId = ref<number | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyUrl(row: DebugSampleDto): Promise<void> {
  try {
    await navigator.clipboard.writeText(row.url)
    copiedId.value = row.id
    ElMessage.success('已复制网址')
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      if (copiedId.value === row.id) copiedId.value = null
    }, 1600)
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选择复制')
  }
}

/* --------------------------------- 覆盖保护 --------------------------------- */

const togglingId = ref<number | null>(null)

async function toggle(row: DebugSampleDto): Promise<void> {
  togglingId.value = row.id
  try {
    await updateDebugSample(row.id, { overridable: !row.overridable })
    ElMessage.success(
      row.overridable
        ? '已锁定：捕获浏览器再次访问该网址时不会覆盖这条存档'
        : '已解锁：捕获浏览器再次访问该网址时会覆盖为最新内容',
    )
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    togglingId.value = null
  }
}

/* --------------------------------- 删除 --------------------------------- */

const deleteVisible = ref(false)
const deleteTarget = ref<DebugSampleDto | null>(null)
const deleteLoading = ref(false)

function askDelete(row: DebugSampleDto): void {
  deleteTarget.value = row
  deleteVisible.value = true
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await deleteDebugSample(deleteTarget.value.id)
    ElMessage.success('已删除该条调试数据')
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

const batchVisible = ref(false)
const batchLoading = ref(false)

async function confirmBatchDelete(): Promise<void> {
  batchLoading.value = true
  try {
    const params =
      batchMode.value === 'selection'
        ? { ids: selection.value.map((row) => row.id).join(',') }
        : {
            keyword: list.filters.keyword || undefined,
            contentType: (list.filters.contentType || undefined) as DebugContentType | undefined,
            overridable: (list.filters.overridable || undefined) as 'true' | 'false' | undefined,
          }
    const { deleted } = await deleteDebugSamples(params)
    ElMessage.success(`已删除 ${deleted} 条调试数据`)
    batchVisible.value = false
    selection.value = []
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    batchLoading.value = false
  }
}

/* ------------------------------- 批量设置可覆盖 ------------------------------- */

const batchOverridableVisible = ref(false)
const batchOverridableLoading = ref(false)
/** 弹窗里选择的目标值：true = 允许覆盖，false = 锁定 */
const batchOverridableValue = ref<'true' | 'false'>('false')

function openBatchOverridable(): void {
  // 默认建议「锁定」：批量放开覆盖风险更大，让用户显式选择
  batchOverridableValue.value = 'false'
  batchOverridableVisible.value = true
}

async function confirmBatchOverridable(): Promise<void> {
  batchOverridableLoading.value = true
  try {
    const scope =
      batchMode.value === 'selection'
        ? { ids: selection.value.map((row) => row.id).join(',') }
        : {
            keyword: list.filters.keyword || undefined,
            contentType: (list.filters.contentType || undefined) as DebugContentType | undefined,
          }
    const { updated } = await setDebugSamplesOverridable({
      ...scope,
      overridable: batchOverridableValue.value,
    })
    ElMessage.success(
      batchOverridableValue.value === 'true'
        ? `已放开 ${updated} 条：捕获浏览器可覆盖`
        : `已锁定 ${updated} 条：捕获浏览器不会覆盖`,
    )
    batchOverridableVisible.value = false
    selection.value = []
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    batchOverridableLoading.value = false
  }
}

/* --------------------------------- 展示辅助 -------------------------------- */

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="调试数据"
      description="按网址存档响应原文：采集任务与规则测试器发请求前先查这里，网址完全一致时直接返回 raw，不再访问目标站点。"
    >
      <template #actions>
        <el-tooltip
          :content="captureRunning ? '捕获浏览器正在运行，先在页面下方停止它' : '在服务端打开浏览器，访问的网页自动入库'"
          placement="bottom"
        >
          <span>
            <el-button :disabled="captureRunning" @click="openCaptureDialog">
              <Globe :size="14" />
              启动浏览器
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          :content="
            batchMode === 'selection'
              ? `修改勾选的 ${batchCount} 条`
              : batchMode === 'filters'
                ? '按当前筛选条件修改'
                : '请先勾选记录或设置筛选条件'
          "
          :disabled="Boolean(batchMode)"
          placement="bottom"
        >
          <span>
            <el-button
              :disabled="!batchMode"
              @click="openBatchOverridable"
            >
              <Lock :size="14" />
              批量设置覆盖
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          :content="
            batchMode === 'selection'
              ? `删除勾选的 ${batchCount} 条`
              : batchMode === 'filters'
                ? '按当前筛选条件删除'
                : '请先勾选记录或设置筛选条件'
          "
          :disabled="Boolean(batchMode)"
          placement="bottom"
        >
          <span>
            <el-button
              type="danger"
              plain
              :disabled="!batchMode"
              :loading="batchLoading"
              @click="batchVisible = true"
            >
              <Trash2 :size="14" />
              批量删除
            </el-button>
          </span>
        </el-tooltip>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          新增调试数据
        </el-button>
      </template>
    </PageHeader>

    <!-- 捕获浏览器状态：运行中 / 上次会话统计 -->
    <section v-if="captureVisible && capture" class="capture-bar" :class="{ 'is-running': captureRunning }">
      <div class="capture-bar__main">
        <span class="capture-dot" />
        <div class="capture-bar__text">
          <span class="capture-title">{{ captureTitle }}</span>
          <span class="capture-desc">
            已记录 <b>{{ capture.captured }}</b> 个页面（新增 {{ capture.created }} / 覆盖 {{ capture.updated }}）
            <template v-if="capture.skipped"> · 跳过 {{ capture.skipped }}</template>
            <template v-if="capture.failed"> · 失败 {{ capture.failed }}</template>
            <template v-if="capture.includeJson"> · 含接口 JSON</template>
          </span>
        </div>
      </div>

      <div class="capture-bar__last">
        <span v-if="capture.lastUrl" class="capture-url wb-mono" :title="capture.lastUrl">
          最近：{{ capture.lastUrl }}
        </span>
        <span v-else class="wb-muted">还没有捕获到页面</span>
      </div>

      <div class="capture-bar__actions">
        <el-popover v-if="capture.recent.length > 0" placement="bottom-end" :width="460" trigger="click">
          <template #reference>
            <el-button size="small" text>最近捕获 {{ capture.recent.length }} 条</el-button>
          </template>
          <ul class="capture-recent">
            <li v-for="item in capture.recent" :key="`${item.sampleId}-${item.capturedAt}`">
              <span class="wb-tag" :class="item.isNew ? 'wb-tag--success' : 'wb-tag--info'">
                {{ item.isNew ? '新增' : '覆盖' }}
              </span>
              <span class="wb-mono capture-recent__url" :title="item.url">{{ item.url }}</span>
              <span class="wb-muted capture-recent__size">{{ formatBytes(item.rawSize) }}</span>
            </li>
          </ul>
        </el-popover>
        <el-button
          v-if="captureRunning"
          size="small"
          type="danger"
          plain
          :loading="captureStopping"
          @click="stopCapture"
        >
          <CircleStop :size="13" />
          停止浏览器
        </el-button>
        <el-button v-else size="small" @click="openCaptureDialog">
          <Globe :size="13" />
          再次启动
        </el-button>
        <el-button size="small" text @click="list.load()">
          <RefreshCw :size="13" />
          刷新列表
        </el-button>
      </div>

      <p v-if="capture.lastError" class="capture-error">{{ capture.lastError }}</p>
    </section>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar
        v-model="list.filters.keyword"
        placeholder="搜索网址 / 备注"
        @search="list.search()"
      />
      <el-select
        v-model="list.filters.contentType"
        placeholder="全部类型"
        clearable
        style="width: 120px"
        @change="list.search()"
      >
        <el-option
          v-for="item in CONTENT_TYPES"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select
        v-model="list.filters.overridable"
        placeholder="覆盖保护"
        clearable
        style="width: 120px"
        @change="list.search()"
      >
        <el-option label="可覆盖" value="true" />
        <el-option label="不可覆盖" value="false" />
      </el-select>
    </FilterBar>

    <DataTable
      :rows="list.rows.value"
      :loading="list.loading.value"
      :error="list.error.value"
      :total="list.total.value"
      :page="list.page.value"
      :page-size="list.pageSize.value"
      :selectable="true"
      :show-pagination="true"
      empty-title="还没有调试数据"
      empty-description="新增一条后，采集 / 测试这个网址时将直接使用这里的 raw，不再访问站点"
      @selection-change="onSelectionChange"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="网址" min-width="340">
        <template #default="{ row }">
          <div class="cell-main">
            <div class="cell-url-row">
              <el-tooltip :content="row.url" placement="top" :show-after="400">
                <span class="cell-url wb-mono">{{ row.url }}</span>
              </el-tooltip>
              <el-tooltip content="复制网址" placement="top" :show-after="200">
                <el-button class="cell-copy" size="small" text @click="copyUrl(row)">
                  <component :is="copiedId === row.id ? Check : Copy" :size="13" />
                </el-button>
              </el-tooltip>
            </div>
            <span v-if="row.note" class="wb-muted cell-sub">{{ row.note }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="类型" width="86">
        <template #default="{ row }">
          <span class="wb-tag" :class="row.contentType === 'json' ? 'wb-tag--warning' : 'wb-tag--info'">
            {{ row.contentType.toUpperCase() }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="大小" width="96">
        <template #default="{ row }">
          <span class="wb-muted cell-size">{{ formatBytes(row.rawSize) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="命中" width="136">
        <template #default="{ row }">
          <div class="cell-main">
            <span class="cell-size">{{ row.hitCount }} 次</span>
            <span v-if="row.lastHitAt" class="wb-muted cell-sub">
              {{ formatTime(row.lastHitAt) }}
            </span>
            <span v-else class="wb-muted cell-sub">尚未命中</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="覆盖" width="96">
        <template #default="{ row }">
          <el-tooltip
            :content="row.overridable ? '可覆盖：捕获浏览器会更新这条存档' : '已锁定：捕获浏览器不会覆盖这条存档'"
            placement="top"
            :show-after="400"
          >
            <el-switch
              :model-value="row.overridable"
              :loading="togglingId === row.id"
              size="small"
              @change="toggle(row)"
            />
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column label="更新时间" width="150">
        <template #default="{ row }">
          <span class="wb-muted">{{ formatTime(row.updatedAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="196" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text @click="openView(row)">
              <Eye :size="13" />
              查看
            </el-button>
            <el-button size="small" text @click="openEdit(row)">
              <Pencil :size="13" />
              编辑
            </el-button>
            <el-button size="small" text type="danger" @click="askDelete(row)">删除</el-button>
          </div>
        </template>
      </el-table-column>

      <template #empty-actions>
        <el-button type="primary" @click="openCreate">
          <Plus :size="14" />
          新增调试数据
        </el-button>
      </template>
    </DataTable>

    <!-- 新增 / 编辑 -->
    <FormDialog
      v-model="dialogVisible"
      :title="editingId ? `编辑调试数据 #${editingId}` : '新增调试数据'"
      :width="860"
      :loading="submitting || loadingDetail"
      @submit="submit"
    >
      <el-form ref="formRef" :model="draftForm" :rules="rules" label-width="86px" :disabled="loadingDetail">
        <el-form-item label="网址" prop="url">
          <el-input v-model="draftForm.url" placeholder="完整网址，例如文章详情页地址" clearable />
          <p class="form-hint">必须与采集 / 测试时的完整网址一致（含协议与查询参数），才会命中。</p>
        </el-form-item>

        <div class="form-row">
          <el-form-item label="状态码">
            <el-input-number
              v-model="draftForm.statusCode"
              :min="100"
              :max="599"
              :step="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="原文类型">
            <el-radio-group v-model="draftForm.contentType">
              <el-radio-button v-for="item in CONTENT_TYPES" :key="item.value" :value="item.value">
                {{ item.label }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="允许覆盖">
            <el-switch v-model="draftForm.overridable" />
            <p class="form-hint">关闭后，捕获浏览器再次访问该网址时不会覆盖这条存档。</p>
          </el-form-item>
        </div>

        <el-form-item label="备注">
          <el-input v-model="draftForm.note" maxlength="200" show-word-limit placeholder="例如：文章页改版前的存档（可不填）" />
        </el-form-item>

        <el-form-item label="raw" prop="raw">
          <el-input
            v-model="draftForm.raw"
            type="textarea"
            :rows="14"
            class="raw-input"
            placeholder="粘贴完整的响应原文（HTML 或 JSON），命中后直接交给解析管道"
          />
          <div class="raw-meta">
            <span :class="{ 'is-over': rawBytes > RAW_MAX_BYTES }">{{ formatBytes(rawBytes) }}</span>
            <span class="wb-muted">上限 20 MB</span>
          </div>
        </el-form-item>
      </el-form>
    </FormDialog>

    <!-- 查看原文 -->
    <el-drawer v-model="viewVisible" :title="detail ? `调试数据 #${detail.id}` : '调试数据'" size="680px">
      <div v-if="viewLoading" class="view-loading">加载中…</div>
      <template v-else-if="detail">
        <dl class="wb-kv">
          <dt>网址</dt>
          <dd class="wb-mono break-all">{{ detail.url }}</dd>
          <dt>类型</dt>
          <dd>{{ detail.contentType.toUpperCase() }} · 状态码 {{ detail.statusCode }}</dd>
          <dt>大小</dt>
          <dd>{{ formatBytes(detail.rawSize) }}</dd>
          <dt>命中</dt>
          <dd>{{ detail.hitCount }} 次{{ detail.lastHitAt ? ` · 最近 ${formatTime(detail.lastHitAt)}` : '' }}</dd>
          <dt>覆盖</dt>
          <dd>{{ detail.overridable ? '允许（捕获浏览器可更新 raw）' : '锁定（捕获浏览器不会覆盖）' }}</dd>
          <dt>备注</dt>
          <dd>{{ detail.note || '—' }}</dd>
          <dt>更新</dt>
          <dd>{{ formatTime(detail.updatedAt) }}</dd>
        </dl>

        <div class="raw-head">
          <span class="raw-head__title">raw</span>
          <el-button size="small" text @click="copyRaw">
            <Copy :size="13" />
            复制全文
          </el-button>
        </div>
        <p v-if="rawPreview.truncated" class="wb-muted truncate-hint">
          原文较长，这里只渲染前 200,000 个字符；完整内容请点「复制全文」。
        </p>
        <pre class="wb-code raw-preview">{{ rawPreview.text }}</pre>
      </template>
    </el-drawer>

    <!-- 删除单条 -->
    <ConfirmDialog
      v-model="deleteVisible"
      title="删除调试数据"
      :danger="true"
      :loading="deleteLoading"
      confirm-text="删除"
      @confirm="confirmDelete"
    >
      <p class="wb-secondary">删除后，采集 / 测试该网址将重新访问真实站点：</p>
      <p class="danger-text break-all">{{ deleteTarget?.url }}</p>
    </ConfirmDialog>

    <!-- 批量删除 -->
    <ConfirmDialog
      v-model="batchVisible"
      title="批量删除调试数据"
      :danger="true"
      :loading="batchLoading"
      confirm-text="删除"
      @confirm="confirmBatchDelete"
    >
      <p v-if="batchMode === 'selection'" class="wb-secondary">
        将删除勾选的 <b>{{ batchCount }}</b> 条调试数据：
      </p>
      <template v-else>
        <p class="wb-secondary">将删除符合以下条件的调试数据：</p>
        <p class="danger-text">{{ filterText }}</p>
      </template>
      <p class="wb-secondary">共 {{ batchCount }} 条待匹配，删除后不可恢复。</p>
    </ConfirmDialog>

    <!-- 批量设置可覆盖 -->
    <ConfirmDialog
      v-model="batchOverridableVisible"
      title="批量设置覆盖保护"
      :loading="batchOverridableLoading"
      confirm-text="应用"
      @confirm="confirmBatchOverridable"
    >
      <p v-if="batchMode === 'selection'" class="wb-secondary">
        将修改勾选的 <b>{{ batchCount }}</b> 条调试数据：
      </p>
      <template v-else>
        <p class="wb-secondary">将修改符合以下条件的调试数据：</p>
        <p class="wb-secondary">{{ filterText }}</p>
      </template>
      <el-radio-group v-model="batchOverridableValue" class="overridable-choice">
        <el-radio value="false">
          <span class="overridable-option">
            <Lock :size="13" />
            锁定 —— 捕获浏览器不再覆盖这些存档
          </span>
        </el-radio>
        <el-radio value="true">
          <span class="overridable-option">
            <Unlock :size="13" />
            允许覆盖 —— 捕获浏览器可更新这些存档
          </span>
        </el-radio>
      </el-radio-group>
      <p class="wb-secondary">共 {{ batchCount }} 条待匹配，只影响捕获浏览器，采集 / 测试命中不受影响。</p>
    </ConfirmDialog>

    <!-- 启动捕获浏览器 -->
    <FormDialog
      v-model="captureDialogVisible"
      title="启动捕获浏览器"
      :width="640"
      :loading="captureStarting"
      submit-text="启动浏览器"
      @submit="submitCapture"
    >
      <p class="capture-tip">
        浏览器会在<b>运行后端的机器</b>上打开一个 Chromium 窗口。你在这个窗口里访问的每个网页，
        响应原文都会自动写入调试库；之后采集 / 测试同一网址时直接命中，不再访问目标站点。
        登录状态保存在独立浏览器目录里，下次启动仍然有效。
      </p>
      <p class="capture-tip">
        只记录状态码 <b>200 / 304</b> 的响应：200 取原始字节，304 是缓存命中（内容取自浏览器已渲染的页面）；
        4xx / 5xx 的错误页与跳转响应不入库。
      </p>

      <el-form label-width="94px" @submit.prevent>
        <el-form-item label="起始网址">
          <el-input v-model="captureForm.startUrl" placeholder="可选，例如要分析的文章列表页" clearable />
          <p class="form-hint">不填则打开空白页，在浏览器窗口里自行输入地址。</p>
        </el-form-item>
        <el-form-item label="记录接口">
          <div class="capture-switch">
            <el-switch v-model="captureForm.includeJson" />
            <span class="wb-muted">同时记录 XHR / Fetch 返回的 JSON（SPA 接口调试用）</span>
          </div>
        </el-form-item>
        <el-form-item label="无头模式">
          <div class="capture-switch">
            <el-switch v-model="captureForm.headless" />
            <span class="wb-muted">不显示窗口，只加载起始网址（无桌面环境的服务器用）</span>
          </div>
        </el-form-item>
      </el-form>
    </FormDialog>
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
  min-width: 0;
}

.cell-url {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-url-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.cell-url-row .cell-url {
  flex: 1;
}

.cell-copy {
  flex: none;
  padding: 2px 4px;
}

.cell-sub {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-size {
  font-size: 12px;
}

.row-actions {
  display: flex;
  gap: 0;
}

.form-hint {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--wb-text-muted);
  line-height: 1.6;
}

.form-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 8px;
}

.form-row :deep(.el-form-item) {
  margin-right: 0;
}

.raw-input :deep(textarea) {
  font-family: var(--wb-font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.raw-meta {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  color: var(--wb-text-secondary);
}

.raw-meta .is-over {
  color: var(--wb-danger);
  font-weight: 600;
}

/* ------------------------------ 捕获浏览器 ------------------------------ */

.capture-bar {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: 8px 14px;
  padding: 10px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  box-shadow: var(--wb-shadow-sm);
}

.capture-bar.is-running {
  border-color: color-mix(in srgb, var(--wb-success) 45%, var(--wb-border));
  background: color-mix(in srgb, var(--wb-success-soft) 32%, var(--wb-surface));
}

.capture-bar__main {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.capture-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wb-text-muted);
  flex: none;
}

.is-running .capture-dot {
  background: var(--wb-success);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--wb-success) 18%, transparent);
  animation: capture-pulse 1.8s ease-in-out infinite;
}

@keyframes capture-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.capture-bar__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.capture-title {
  font-size: 13px;
  font-weight: 600;
}

.capture-desc {
  font-size: 11.5px;
  color: var(--wb-text-secondary);
}

.capture-bar__last {
  min-width: 0;
}

.capture-url {
  display: block;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capture-bar__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.capture-error {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 11.5px;
  color: var(--wb-danger);
  word-break: break-all;
}

.capture-recent {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.capture-recent li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.capture-recent__url {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capture-recent__size {
  flex: none;
  font-size: 11px;
}

.capture-tip {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--wb-text-secondary);
}

.capture-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.view-loading {
  padding: 20px 0;
  font-size: 12.5px;
  color: var(--wb-text-muted);
}

.raw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 6px;
}

.raw-head__title {
  font-size: 13px;
  font-weight: 600;
}

.truncate-hint {
  margin: 0 0 6px;
  font-size: 11.5px;
}

.raw-preview {
  margin: 0;
  max-height: calc(100vh - 380px);
  overflow: auto;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.danger-text {
  margin: 6px 0;
  font-size: 13px;
  color: var(--wb-danger);
}

.overridable-choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin: 10px 0;
}

.overridable-option {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.break-all {
  word-break: break-all;
}
</style>
