<script setup lang="ts">
import { computed } from 'vue'
import type { TesterListResultDto } from '@webcrawler/shared'
import { RefreshCw } from '@lucide/vue'

const props = defineProps<{
  /** 列表模式配置（v-model 系列字段） */
  itemSelector: string
  /** 选中全流程列表插件：列表由插件整段返回，只需填写分页方式 */
  pluginMode?: boolean
  paginationType: 'none' | 'query' | 'path' | 'next' | 'cursor'
  paginationParameter: string
  paginationPathPattern: string
  maxPages: number | null
  testing: boolean
  result: TesterListResultDto | null
  /** 当前详情模式选中的地址（用于高亮「进入详情测试」目标） */
  detailUrl: string
}>()

const emit = defineEmits<{
  'update:itemSelector': [value: string]
  'update:paginationType': [value: 'none' | 'query' | 'path' | 'next' | 'cursor']
  'update:paginationParameter': [value: string]
  'update:paginationPathPattern': [value: string]
  'update:maxPages': [value: number | null]
  test: []
  pickDetail: [url: string]
}>()

const PAGINATION_OPTIONS = [
  { value: 'none', label: '不翻页' },
  { value: 'query', label: '页码参数（?page=N）' },
  { value: 'path', label: '路径模板（/page/{page}）' },
  { value: 'next', label: '下一页链接（暂未实现，保存会被拒绝）' },
  { value: 'cursor', label: '游标（暂未实现，保存会被拒绝）' },
] as const

const duplicateWarning = computed(() => {
  if (!props.result?.ok) return null
  return props.result.duplicateCount > 0
    ? `发现 ${props.result.duplicateCount} 条重复/非法链接`
    : '没有重复链接'
})

/** 预览行的次要信息：作者 / 文章时间 / 摘要，只显示抽到的部分。 */
function linkMeta(link: { author?: string | null; articleTime?: string | null; summary?: string | null }): string {
  const summary = link.summary ? `${link.summary.slice(0, 40)}${link.summary.length > 40 ? '…' : ''}` : ''
  return [link.author, link.articleTime, summary].filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="list-config">
    <div class="config-grid">
      <label v-if="!pluginMode" class="span-2">
        <span>列表项容器 itemSelector *</span>
        <el-input
          :model-value="itemSelector"
          size="small"
          placeholder=".news-item"
          @update:model-value="emit('update:itemSelector', $event)"
        />
      </label>
      <p v-else class="span-2 plugin-note">
        列表由全流程插件返回，无需选择器与列表字段；只需设置下方分页方式。
      </p>
      <label>
        <span>分页方式</span>
        <el-select
          :model-value="paginationType"
          size="small"
          @update:model-value="emit('update:paginationType', $event)"
        >
          <el-option v-for="item in PAGINATION_OPTIONS" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
      </label>
      <div class="pair">
        <label v-if="paginationType === 'query' || paginationType === 'cursor'">
          <span>参数名</span>
          <el-input
            :model-value="paginationParameter"
            size="small"
            @update:model-value="emit('update:paginationParameter', $event)"
          />
        </label>
        <label v-if="paginationType === 'path'">
          <span>路径模板</span>
          <el-input
            :model-value="paginationPathPattern"
            size="small"
            placeholder="/page/{page}"
            @update:model-value="emit('update:paginationPathPattern', $event)"
          />
        </label>
        <label v-if="['query', 'path', 'cursor'].includes(paginationType)">
          <span>最大页数</span>
          <el-input-number
            :model-value="maxPages ?? undefined"
            size="small"
            :min="1"
            :max="999"
            controls-position="right"
            @update:model-value="emit('update:maxPages', $event ?? null)"
          />
        </label>
      </div>
    </div>


    <div class="test-row">
      <el-button
        type="primary"
        size="small"
        :loading="testing"
        :disabled="!pluginMode && !itemSelector"
        :icon="RefreshCw"
        @click="emit('test')"
      >
        测试列表规则
      </el-button>
      <span v-if="result" class="test-summary" :class="result.ok ? 'is-ok' : 'is-bad'">
        {{ result.message }}
      </span>
    </div>

    <div v-if="duplicateWarning" class="dup" :class="result?.duplicateCount ? 'is-warn' : 'is-ok'">
      {{ duplicateWarning }}
    </div>

    <div v-if="result?.ok && result.links.length > 0" class="links">
      <p class="links-head">
        文章链接（预览 {{ result.links.length }} / 共 {{ result.linkCount }} 条）——点击任一条进入详情测试
      </p>
      <div
        v-for="link in result.links"
        :key="link.url"
        class="link-row"
        :class="{ 'is-active': link.url === detailUrl }"
        :title="link.url"
        @click="emit('pickDetail', link.url)"
      >
        <img v-if="link.coverUrl" class="link-cover" :src="link.coverUrl" alt="" loading="lazy" />
        <span class="link-body">
          <span class="link-title">{{ link.title || '(无标题)' }}</span>
          <span v-if="linkMeta(link)" class="link-meta">{{ linkMeta(link) }}</span>
        </span>
        <code class="link-url">{{ link.url }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.config-grid label,
.pair label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}

.span-2 {
  grid-column: span 2;
}

.plugin-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}


.pair {
  display: flex;
  gap: 12px;
}

.pair label {
  flex: 1;
}

.test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.test-summary {
  font-size: 12px;
}

.test-summary.is-ok {
  color: var(--wb-success);
}

.test-summary.is-bad {
  color: var(--wb-danger);
}

.dup {
  margin-top: 6px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--wb-radius-sm);
  width: fit-content;
}

.dup.is-warn {
  background: #fff7e6;
  color: var(--wb-warning);
}

.dup.is-ok {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}

.links {
  margin-top: 12px;
  border-top: 1px solid var(--wb-border);
  padding-top: 8px;
}

.links-head {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--wb-radius-sm);
  cursor: pointer;
  min-width: 0;
}

.link-row:hover {
  background: var(--wb-primary-soft);
}

.link-row.is-active {
  background: var(--wb-success-soft);
}

.link-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 0 1 auto;
  min-width: 0;
}

.link-title {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.link-meta {
  font-size: 11px;
  color: var(--wb-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.link-cover {
  flex: 0 0 auto;
  width: 28px;
  height: 20px;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
}

.link-url {
  flex: 1 1 auto;
  font-size: 11px;
  color: var(--wb-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
</style>
