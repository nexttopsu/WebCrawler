<script setup lang="ts">
import { computed } from 'vue'
import type { TesterListResultDto } from '@webcrawler/shared'
import { RefreshCw } from '@lucide/vue'

const props = defineProps<{
  /** 列表模式配置（v-model） */
  itemSelector: string
  /** 选中全流程列表插件：列表由插件整段返回，无需选择器与列表字段 */
  pluginMode?: boolean
  testing: boolean
  result: TesterListResultDto | null
  /** 当前详情模式选中的地址（用于高亮「进入详情测试」目标） */
  detailUrl: string
}>()

const emit = defineEmits<{
  'update:itemSelector': [value: string]
  test: []
  pickDetail: [url: string]
}>()

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
    <div v-if="!pluginMode" class="tester-field">
      <span class="tester-field__label">列表项容器 itemSelector <em class="req">*</em></span>
      <el-input
        :model-value="itemSelector"
        placeholder=".news-item"
        @update:model-value="emit('update:itemSelector', $event)"
      />
      <p class="tester-field__hint">列表里每篇文章重复出现的容器节点，例如 ul.list &gt; li.item。</p>
    </div>
    <p v-else class="plugin-note">
      列表由全流程插件整段返回，无需选择器与列表字段；分页方式在下方「高级设置」中配置。
    </p>

    <!-- 字段配置等插在核心配置与测试按钮之间（由父组件通过默认插槽传入） -->
    <slot />

    <div class="test-row">
      <el-button
        type="primary"
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
.list-config {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.plugin-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}

.test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
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
  margin-top: 8px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--wb-radius-sm);
  width: fit-content;
}

.dup.is-warn {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.dup.is-ok {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}

.links {
  margin-top: 14px;
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
