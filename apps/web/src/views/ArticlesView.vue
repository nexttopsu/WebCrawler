<script setup lang="ts">
/**
 * 文章数据列表。
 *
 * 列表不返回正文（由服务端控制体积）；导出走后端流式接口，
 * 前端只负责触发下载，不在浏览器里拼大数组。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download, Eye, FileJson, FileSpreadsheet, RefreshCw, Trash2 } from '@lucide/vue'
import type { ArticleSummaryDto, CategoryDto, SiteDto } from '@webcrawler/shared'
import { deleteArticle, deleteArticles, exportArticles, listArticles } from '@/api/articles'
import { listSites } from '@/api/sites'
import { listCategories } from '@/api/categories'
import { errorMessage } from '@/api/client'
import { useListQuery } from '@/composables/useListQuery'
import PageHeader from '@/components/common/PageHeader.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import DataTable from '@/components/common/DataTable.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import { ARTICLE_STATUS_MAP } from '@/config/status'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const router = useRouter()

const list = useListQuery<
  ArticleSummaryDto,
  {
    keyword: string
    siteId?: number
    categoryId?: number
    status: string
    range: [string, string] | null
  }
>(
  (params) =>
    listArticles({
      page: params.page,
      pageSize: params.pageSize,
      keyword: params.keyword || undefined,
      siteId: params.siteId || undefined,
      categoryId: params.categoryId || undefined,
      status: params.status || undefined,
      crawledFrom: params.range?.[0],
      crawledTo: params.range?.[1],
      sort: 'crawlTime',
      order: 'desc',
    }),
  { keyword: '', siteId: undefined, categoryId: undefined, status: '', range: null },
)

const siteOptions = ref<SiteDto[]>([])
const categoryOptions = ref<CategoryDto[]>([])
const siteNameMap = computed(() => new Map(siteOptions.value.map((site) => [site.id, site.name])))
const categoryNameMap = computed(() => new Map(categoryOptions.value.map((item) => [item.id, item.name])))

async function loadSiteOptions(): Promise<void> {
  try {
    const page = await listSites({ pageSize: 100 })
    siteOptions.value = page.items
  } catch {
    siteOptions.value = []
  }
}

async function loadCategoryOptions(siteId?: number): Promise<void> {
  try {
    const page = await listCategories({ siteId, pageSize: 100 })
    categoryOptions.value = page.items
  } catch {
    categoryOptions.value = []
  }
}

watch(
  () => list.filters.siteId,
  (siteId) => {
    list.filters.categoryId = undefined
    void loadCategoryOptions(siteId || undefined)
  },
)

/* -------------------------------- 选择与删除 ------------------------------- */

const selected = ref<ArticleSummaryDto[]>([])

function onSelectionChange(rows: unknown[]): void {
  selected.value = rows as ArticleSummaryDto[]
}

const deleteVisible = ref(false)
const deleteMode = ref<'single' | 'batch'>('single')
const deleteTarget = ref<ArticleSummaryDto | null>(null)
const deleteLoading = ref(false)

function askDelete(row: ArticleSummaryDto): void {
  deleteMode.value = 'single'
  deleteTarget.value = row
  deleteVisible.value = true
}

function askBatchDelete(): void {
  if (selected.value.length === 0) return
  deleteMode.value = 'batch'
  deleteTarget.value = null
  deleteVisible.value = true
}

async function confirmDelete(): Promise<void> {
  deleteLoading.value = true
  try {
    if (deleteMode.value === 'single' && deleteTarget.value) {
      await deleteArticle(deleteTarget.value.id)
      ElMessage.success('文章已删除')
    } else {
      const result = await deleteArticles(selected.value.map((row) => row.id))
      ElMessage.success(
        result.missing.length
          ? `已删除 ${result.deleted} 篇，${result.missing.length} 篇已不存在`
          : `已删除 ${result.deleted} 篇文章`,
      )
      selected.value = []
    }
    deleteVisible.value = false
    await list.load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    deleteLoading.value = false
  }
}

/* ---------------------------------- 导出 ---------------------------------- */

const exporting = ref<'json' | 'csv' | null>(null)

async function exportAs(format: 'json' | 'csv'): Promise<void> {
  exporting.value = format
  try {
    await exportArticles(
      {
        keyword: list.filters.keyword || undefined,
        siteId: list.filters.siteId || undefined,
        categoryId: list.filters.categoryId || undefined,
        status: list.filters.status || undefined,
        crawledFrom: list.filters.range?.[0],
        crawledTo: list.filters.range?.[1],
        sort: 'crawlTime',
        order: 'desc',
      },
      format,
      1000,
    )
    ElMessage.success(`已导出当前筛选结果（${format.toUpperCase()}，最多 1000 篇）`)
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    exporting.value = null
  }
}

/* --------------------------------- 展示辅助 -------------------------------- */

/** 表格里的时间：省掉年份，给固定列留出宽度。 */
function formatTableTime(value: string | null): string {
  const full = formatTime(value)
  return full.length > 10 ? full.slice(5) : full
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

void loadSiteOptions()
void loadCategoryOptions()
</script>

<template>
  <div class="view">
    <PageHeader title="文章数据" description="采集结果按站点、栏目与时间筛选，支持导出 JSON 与 CSV。">
      <template #actions>
        <el-button :disabled="selected.length === 0" @click="askBatchDelete">
          <Trash2 :size="14" />
          <span>批量删除{{ selected.length ? `（${selected.length}）` : '' }}</span>
        </el-button>
        <el-dropdown trigger="click">
          <el-button :loading="exporting !== null">
            <Download :size="14" />
            <span>导出</span>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="exportAs('json')">
                <FileJson :size="14" />
                <span>导出 JSON</span>
              </el-dropdown-item>
              <el-dropdown-item @click="exportAs('csv')">
                <FileSpreadsheet :size="14" />
                <span>导出 CSV</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button :loading="list.loading.value" @click="list.load()">
          <RefreshCw :size="14" />
        </el-button>
      </template>
    </PageHeader>

    <FilterBar :active="list.isFiltered()" @reset="list.reset()">
      <SearchBar v-model="list.filters.keyword" placeholder="搜索标题、正文或作者" :width="260" @search="list.search()" />
      <el-select
        v-model="list.filters.siteId"
        placeholder="全部网站"
        clearable
        filterable
        style="width: 170px"
        @change="list.search()"
      >
        <el-option v-for="site in siteOptions" :key="site.id" :label="site.name" :value="site.id" />
      </el-select>
      <el-select
        v-model="list.filters.categoryId"
        placeholder="全部栏目"
        clearable
        filterable
        style="width: 160px"
        @change="list.search()"
      >
        <el-option v-for="item in categoryOptions" :key="item.id" :label="item.name" :value="item.id" />
      </el-select>
      <el-select v-model="list.filters.status" placeholder="全部状态" clearable style="width: 130px" @change="list.search()">
        <el-option label="待处理" value="pending" />
        <el-option label="已发布" value="published" />
        <el-option label="已忽略" value="ignored" />
      </el-select>
      <el-date-picker
        v-model="list.filters.range"
        type="datetimerange"
        value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
        start-placeholder="采集开始"
        end-placeholder="采集结束"
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
      selectable
      empty-title="还没有采集到文章"
      empty-description="先创建采集任务，成功后文章会出现在这里"
      @selection-change="onSelectionChange"
      @update:page="(value: number) => { list.setPage(value); list.load() }"
      @update:page-size="(value: number) => { list.setPageSize(value); list.load() }"
      @retry="list.load()"
      @refresh="list.load()"
    >
      <el-table-column label="标题" min-width="260">
        <template #default="{ row }">
          <div class="cell-main">
            <button class="cell-title cell-title--link" type="button" @click="router.push(`/articles/${row.id}`)">
              {{ row.title || '（无标题）' }}
            </button>
            <span v-if="row.summary" class="wb-muted cell-sub">{{ row.summary }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="归属" width="150">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ siteNameMap.get(row.siteId) ?? `站点 #${row.siteId}` }}</span>
            <span class="wb-muted cell-sub">
              {{ row.categoryId ? (categoryNameMap.get(row.categoryId) ?? `栏目 #${row.categoryId}`) : '—' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="作者 / 发布" width="150">
        <template #default="{ row }">
          <div class="cell-main">
            <span>{{ row.author || '—' }}</span>
            <span class="wb-muted cell-sub">{{ formatTime(row.publishedAt) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="字数 / 图" width="112">
        <template #default="{ row }">
          <span class="wb-muted">{{ row.wordCount }} 字 · {{ row.imageCount }} 图</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="88">
        <template #default="{ row }">
          <StatusTag :status="row.status" :map="ARTICLE_STATUS_MAP" />
        </template>
      </el-table-column>

      <el-table-column label="采集时间" width="132">
        <template #default="{ row }">
          <span class="wb-muted">{{ formatTableTime(row.crawlTime ?? row.createdAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="172" fixed="right">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button size="small" text @click="router.push(`/articles/${row.id}`)">
              <Eye :size="13" />
              详情
            </el-button>
            <a class="wb-link" :href="row.url" target="_blank" rel="noopener noreferrer">原文</a>
            <el-button size="small" text type="danger" @click="askDelete(row)">
              <Trash2 :size="13" />
            </el-button>
          </div>
        </template>
      </el-table-column>
    </DataTable>

    <ConfirmDialog
      v-model="deleteVisible"
      :title="deleteMode === 'single' ? '删除文章' : '批量删除文章'"
      :danger="true"
      :loading="deleteLoading"
      confirm-text="删除"
      @confirm="confirmDelete"
    >
      <p v-if="deleteMode === 'single'" class="wb-secondary">{{ deleteTarget?.title || '（无标题）' }}</p>
      <p v-else class="wb-secondary">将删除选中的 {{ selected.length }} 篇文章。</p>
      <p class="wb-secondary">删除后不可恢复，关联的图片地址也会失效。</p>
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
  min-width: 0;
}

.cell-title {
  font-weight: 500;
  font-size: 13px;
  text-align: left;
}

.cell-title--link {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  color: var(--wb-text);
  cursor: pointer;
}

.cell-title--link:hover {
  color: var(--wb-primary);
}

.cell-sub {
  font-size: 11.5px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-link {
  font-size: 12px;
  color: var(--wb-primary);
}
</style>
