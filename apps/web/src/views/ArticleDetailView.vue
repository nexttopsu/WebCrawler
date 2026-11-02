<script setup lang="ts">
/**
 * 文章详情。
 *
 * 正文以 HTML 渲染，但必须经过 `sanitizeHtml` 再进 `v-html`：
 * 服务端已经清洗过一次，这里做最后一道防线（历史数据 / 手工导入 / 插件输出）。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, ExternalLink, RefreshCw, Trash2 } from '@lucide/vue'
import type { ArticleDto, ArticleRawDto } from '@webcrawler/shared'
import { deleteArticle, getArticle, getArticleRaw } from '@/api/articles'
import { errorMessage } from '@/api/client'
import { useAsyncState } from '@/composables/useAsyncState'
import { collectImages, sanitizeHtml } from '@/lib/sanitize'
import PageHeader from '@/components/common/PageHeader.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import StatusTag from '@/components/common/StatusTag.vue'
import { ARTICLE_STATUS_MAP } from '@/config/status'
import CodeViewer from '@/components/common/CodeViewer.vue'
import JsonViewer from '@/components/common/JsonViewer.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()

const articleId = computed(() => Number(route.params.id))
const article = useAsyncState<ArticleDto>(() => getArticle(articleId.value))

const safeHtml = computed(() => sanitizeHtml(article.data.value?.contentHtml))

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

const images = computed(() => {
  const fromServer = article.data.value?.images ?? []
  const fromHtml = collectImages(article.data.value?.contentHtml)
  return Array.from(new Set([...fromServer, ...fromHtml]))
})

const tab = ref<'content' | 'text' | 'raw' | 'json' | 'images'>('content')

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

function switchTab(value: 'content' | 'text' | 'raw' | 'json' | 'images'): void {
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
    contentHtml: undefined,
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
          <StatusTag :status="article.data.value.status" :map="ARTICLE_STATUS_MAP" />
          <span class="wb-muted">采集于 {{ formatTime(article.data.value.crawlTime ?? article.data.value.createdAt) }}</span>
          <span v-if="article.data.value.publishedAt" class="wb-muted">
            发布于 {{ formatTime(article.data.value.publishedAt) }}
          </span>
        </div>

        <dl class="wb-kv meta-grid">
          <dt>作者</dt>
          <dd>{{ article.data.value.author || '—' }}</dd>
          <dt>字数</dt>
          <dd>{{ article.data.value.wordCount }}</dd>
          <dt>图片</dt>
          <dd>{{ article.data.value.imageCount }}</dd>
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
              { key: 'text', label: '纯文本' },
              { key: 'images', label: `图片（${images.length}）` },
              { key: 'raw', label: '原始 HTML' },
              { key: 'json', label: 'JSON' },
            ]"
            :key="item.key"
            type="button"
            class="tab-bar__item"
            :class="{ 'is-active': tab === item.key }"
            @click="switchTab(item.key as 'content' | 'text' | 'raw' | 'json' | 'images')"
          >
            {{ item.label }}
          </button>
        </div>

        <div v-show="tab === 'content'" class="tab-panel">
          <div v-if="safeHtml" class="wb-article" v-html="safeHtml" />
          <EmptyState v-else compact title="没有正文 HTML" description="该文章的规则可能只配置了纯文本提取" />
        </div>

        <div v-show="tab === 'text'" class="tab-panel">
          <pre v-if="article.data.value.content" class="wb-code article-text">{{ article.data.value.content }}</pre>
          <EmptyState v-else compact title="没有纯文本正文" />
        </div>

        <div v-show="tab === 'images'" class="tab-panel">
          <div v-if="images.length" class="image-grid">
            <el-image
              v-for="src in images"
              :key="src"
              :src="src"
              :preview-src-list="images"
              fit="cover"
              lazy
              class="image-grid__item"
            />
          </div>
          <EmptyState v-else compact title="没有图片" description="正文中未发现可用的图片地址" />
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

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.image-grid__item {
  width: 100%;
  height: 120px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
  background: var(--wb-surface-muted);
  cursor: zoom-in;
}
</style>
