<script setup lang="ts">
import { computed } from 'vue'
import type { TesterListResultDto } from '@webcrawler/shared'
import { RefreshCw } from '@lucide/vue'

const props = defineProps<{
  /** 列表模式配置（v-model 系列字段） */
  itemSelector: string
  linkSelector: string
  titleSelector: string
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
  'update:linkSelector': [value: string]
  'update:titleSelector': [value: string]
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
</script>

<template>
  <div class="list-config">
    <div class="config-grid">
      <label class="span-2">
        <span>列表项容器 itemSelector *</span>
        <el-input
          :model-value="itemSelector"
          size="small"
          placeholder=".news-item"
          @update:model-value="emit('update:itemSelector', $event)"
        />
      </label>
      <label>
        <span>文章链接 linkSelector</span>
        <el-input
          :model-value="linkSelector"
          size="small"
          placeholder="a.title（默认找第一个 a）"
          @update:model-value="emit('update:linkSelector', $event)"
        />
      </label>
      <label>
        <span>列表标题 titleSelector</span>
        <el-input
          :model-value="titleSelector"
          size="small"
          placeholder=".title（默认用链接文本）"
          @update:model-value="emit('update:titleSelector', $event)"
        />
      </label>
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
        :disabled="!itemSelector"
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
        <span class="link-title">{{ link.title || '(无标题)' }}</span>
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
  align-items: baseline;
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

.link-title {
  flex: 0 1 auto;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
