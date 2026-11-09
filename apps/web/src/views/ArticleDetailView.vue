<script setup lang="ts">
/**
 * 文章详情。
 *
 * 正文为采集到的纯文本；原始 HTML 来自 rawHtml（服务端原样返回，查看时只读）。
 */
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { ArrowLeft, ExternalLink, Pencil, RefreshCw, Trash2 } from '@lucide/vue'
import type { ArticleDto, ArticleRawDto } from '@webcrawler/shared'
import { deleteArticle, getArticle, getArticleRaw, updateArticle } from '@/api/articles'
import { errorMessage } from '@/api/client'
import { useAsyncState } from '@/composables/useAsyncState'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import CodeViewer from '@/components/common/CodeViewer.vue'
import JsonViewer from '@/components/common/JsonViewer.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import FormDialog from '@/components/common/FormDialog.vue'

const route = useRoute()
const router = useRouter()

const articleId = computed(() => Number(route.params.id))
const article = useAsyncState<ArticleDto>(() => getArticle(articleId.value))

/**
 * 页头副标题。
 *
 * 加载失败时不能一直显示「加载中…」，否则错误态和加载态在视觉上分不开。
 */
const headerDescription = computed(() => {
  const value = article.data.value
  if (value) return `${value.siteName ?? '—'} · ${value.categoryName ?? '未分类'}`
  if (article.error.value) return '文章不存在或加载失败'
  return '加载中…'
})

const tab = ref<'content' | 'raw' | 'json'>('content')

/* --------------------------------- 原始 HTML -------------------------------- */

const raw = ref<ArticleRawDto | null>(null)
const rawLoading = ref(false)
const rawError = ref<string | null>(null)

async function loadRaw(): Promise<void> {
  if (raw.value) return
  rawLoading.value = true
  rawError.value = null
  try {
    raw.value = await getArticleRaw(articleId.value)
  } catch (error) {
    rawError.value = errorMessage(error)
  } finally {
    rawLoading.value = false
  }
}

function switchTab(value: 'content' | 'raw' | 'json'): void {
  tab.value = value
  if (value === 'raw') void loadRaw()
}

/* ---------------------------------- 删除 ---------------------------------- */

const deleteVisible = ref(false)
const deleting = ref(false)

async function confirmDelete(): Promise<void> {
  deleting.value = true
  try {
    await deleteArticle(articleId.value)
    ElMessage.success('文章已删除')
    router.push('/articles')
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    deleting.value = false
    deleteVisible.value = false
  }
}

/* ---------------------------------- 编辑 ---------------------------------- */

/**
 * 编辑弹窗：只改采集到的内容字段。
 *
 * 站点、栏目、原文链接是归属信息（服务端白名单外，传了会 400），弹窗里只读展示。
 */
const editVisible = ref(false)
const editSubmitting = ref(false)
const editFormRef = ref<FormInstance>()

const editForm = reactive({
  title: '',
  author: '',
  articleTime: null as string | null,
  coverUrl: '',
  summary: '',
  content: '',
})

const editRules: FormRules = {
  title: [{ required: true, message: '标题不能为空', trigger: 'blur' }],
}

function openEdit(): void {
  const data = article.data.value
  if (!data) return
  editForm.title = data.title
  editForm.author = data.author ?? ''
  // el-date-picker 用本地时间展示，这里转成不带时区的本地写法
  editForm.articleTime = data.articleTime ? toLocalInput(data.articleTime) : null
  editForm.coverUrl = data.coverUrl ?? ''
  editForm.summary = data.summary ?? ''
  editForm.content = data.content ?? ''
  editVisible.value = true
}

/** ISO 字符串 → `YYYY-MM-DDTHH:mm:ss`（按本地时间），供 datetime 输入框回显。 */
function toLocalInput(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 空串转 null：服务端把空串与 null 都视为「清空该字段」。 */
const blankToNull = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

async function submitEdit(): Promise<void> {
  const valid = await editFormRef.value?.validate().catch(() => false)
  if (!valid) return

  editSubmitting.value = true
  try {
    await updateArticle(articleId.value, {
      title: editForm.title.trim(),
      author: blankToNull(editForm.author),
      articleTime: editForm.articleTime,
      coverUrl: blankToNull(editForm.coverUrl),
      summary: blankToNull(editForm.summary),
      content: editForm.content,
    })
    ElMessage.success('文章已更新')
    editVisible.value = false
    article.run()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    editSubmitting.value = false
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

const jsonValue = computed(() => {
  const data = article.data.value
  if (!data) return null
  return {
    ...data,
    // 正文太长，JSON 视图里截断，完整内容看「正文」页签
    content: data.content ? `${data.content.slice(0, 2000)}${data.content.length > 2000 ? '…（已截断）' : ''}` : null,
  }
})
</script>

<template>
  <div class="view">
    <PageHeader
      :title="article.data.value?.title || '文章详情'"
      :description="headerDescription"
    >
      <template #actions>
        <el-button @click="router.push('/articles')">
          <ArrowLeft :size="14" />
          <span>返回列表</span>
        </el-button>
        <el-button :loading="article.loading.value" @click="article.run()">
          <RefreshCw :size="14" />
        </el-button>
        <el-button v-if="article.data.value" type="primary" plain @click="openEdit">
          <Pencil :size="14" />
          <span>编辑</span>
        </el-button>
        <el-button v-if="article.data.value" type="danger" plain @click="deleteVisible = true">
          <Trash2 :size="14" />
        </el-button>
      </template>
    </PageHeader>

    <ErrorState v-if="article.error.value" :message="article.error.value" @retry="article.run()" />
    <LoadingState v-else-if="article.loading.value && !article.data.value" :rows="6" />

    <template v-else-if="article.data.value">
      <section class="wb-card meta-card">
        <div class="meta-card__top">
          <span class="wb-muted">采集于 {{ formatTime(article.data.value.createdAt) }}</span>
          <span v-if="article.data.value.articleTime" class="wb-muted">
            文章时间 {{ formatTime(article.data.value.articleTime) }}
          </span>
        </div>

        <dl class="wb-kv meta-grid">
          <dt>作者</dt>
          <dd>{{ article.data.value.author || '—' }}</dd>
          <dt>原文</dt>
          <dd>
            <a class="wb-link" :href="article.data.value.url" target="_blank" rel="noopener noreferrer">
              {{ article.data.value.url }}
              <ExternalLink :size="12" />
            </a>
          </dd>
        </dl>

        <p v-if="article.data.value.summary" class="meta-summary">{{ article.data.value.summary }}</p>
      </section>

      <section class="wb-card">
        <div class="tab-bar">
          <button
            v-for="item in [
              { key: 'content', label: '正文' },
              { key: 'raw', label: '原始 HTML' },
              { key: 'json', label: 'JSON' },
            ]"
            :key="item.key"
            type="button"
            class="tab-bar__item"
            :class="{ 'is-active': tab === item.key }"
            @click="switchTab(item.key as 'content' | 'raw' | 'json')"
          >
            {{ item.label }}
          </button>
        </div>

        <div v-show="tab === 'content'" class="tab-panel">
          <pre v-if="article.data.value.content" class="wb-code article-text">{{ article.data.value.content }}</pre>
          <EmptyState v-else compact title="没有正文内容" />
        </div>

        <div v-show="tab === 'raw'" class="tab-panel">
          <ErrorState v-if="rawError" compact :message="rawError" @retry="loadRaw()" />
          <LoadingState v-else-if="rawLoading" :rows="4" />
          <CodeViewer
            v-else-if="raw"
            :code="raw.html"
            label="页面原始 HTML"
            :max-height="560"
            show-line-numbers
          />
          <EmptyState v-else compact title="没有原始 HTML" description="历史数据可能只保留了抽取后的字段" />
        </div>

        <div v-show="tab === 'json'" class="tab-panel">
          <JsonViewer :value="jsonValue" :max-height="560" filename="article.json" />
        </div>
      </section>
    </template>

    <ConfirmDialog
      v-model="deleteVisible"
      title="删除文章"
      :danger="true"
      :loading="deleting"
      confirm-text="删除"
      @confirm="confirmDelete"
    >
      <p class="wb-secondary">{{ article.data.value?.title || '（无标题）' }}</p>
      <p class="wb-secondary">删除后不可恢复。</p>
    </ConfirmDialog>

    <FormDialog
      v-model="editVisible"
      title="编辑文章"
      :loading="editSubmitting"
      :width="640"
      description="只能修改采集到的内容字段；站点、栏目、原文链接等归属信息不可修改。作者、摘要、封面留空表示清除。"
      @submit="submitEdit"
    >
      <el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="82px" label-position="right">
        <el-form-item label="标题" prop="title">
          <el-input v-model="editForm.title" maxlength="300" show-word-limit />
        </el-form-item>
        <el-form-item label="站点 / 栏目">
          <el-input :model-value="`${article.data.value?.siteName ?? '—'} · ${article.data.value?.categoryName ?? '未分类'}`" disabled />
        </el-form-item>
        <el-form-item label="原文链接">
          <el-input :model-value="article.data.value?.url" disabled />
        </el-form-item>
        <el-form-item label="作者">
          <el-input v-model="editForm.author" maxlength="100" clearable placeholder="留空表示无作者" />
        </el-form-item>
        <el-form-item label="文章时间">
          <el-date-picker
            v-model="editForm.articleTime"
            type="datetime"
            placeholder="选择原站点发布时间"
            value-format="YYYY-MM-DDTHH:mm:ss"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="封面图">
          <el-input v-model="editForm.coverUrl" clearable placeholder="http(s) 完整地址，留空表示无封面" />
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="editForm.summary" type="textarea" :rows="3" maxlength="5000" show-word-limit />
        </el-form-item>
        <el-form-item label="正文">
          <el-input v-model="editForm.content" type="textarea" :autosize="{ minRows: 10, maxRows: 26 }" placeholder="纯文本正文" />
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

.meta-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-card__top {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.meta-grid {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 48px minmax(0, 1fr);
  gap: 8px 12px;
  font-size: 13px;
}

@media (max-width: 760px) {
  .meta-grid {
    grid-template-columns: 48px minmax(0, 1fr);
  }
}

.meta-grid dt {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}

.meta-grid dd {
  word-break: break-all;
}

.meta-summary {
  font-size: 13px;
  color: var(--wb-text-secondary);
  line-height: 1.75;
  padding-top: 10px;
  border-top: 1px solid var(--wb-border);
}

.wb-link {
  color: var(--wb-primary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  word-break: break-all;
}

.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--wb-border);
  margin-bottom: 12px;
  overflow-x: auto;
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
  white-space: nowrap;
}

.tab-bar__item.is-active {
  color: var(--wb-primary);
  border-bottom-color: var(--wb-primary);
  font-weight: 550;
}

.article-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.85;
  font-family: var(--wb-font);
  font-size: 13.5px;
  max-height: 620px;
  overflow: auto;
  padding: 14px 16px;
}
</style>
