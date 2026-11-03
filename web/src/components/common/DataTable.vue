<script setup lang="ts">
/**
 * 数据表格。
 *
 * 把「加载中 / 空 / 错误 / 分页」四种状态收在一处，
 * 页面只需要关心列定义与行内操作，不再各写一套 el-table 包装。
 */
import EmptyState from './EmptyState.vue'
import ErrorState from './ErrorState.vue'
import Pagination from './Pagination.vue'
import LoadingState from './LoadingState.vue'

withDefaults(
  defineProps<{
    rows: readonly unknown[]
    loading?: boolean
    error?: string | null
    total?: number
    page?: number
    pageSize?: number
    rowKey?: string
    emptyTitle?: string
    emptyDescription?: string
    selectable?: boolean
    showPagination?: boolean
    stripe?: boolean
  }>(),
  {
    loading: false,
    error: null,
    total: 0,
    page: 1,
    pageSize: 20,
    rowKey: 'id',
    emptyTitle: '暂无数据',
    emptyDescription: '',
    selectable: false,
    showPagination: true,
    stripe: true,
  },
)

const emit = defineEmits<{
  'update:page': [value: number]
  'update:pageSize': [value: number]
  retry: []
  refresh: []
  'selection-change': [rows: unknown[]]
}>()

function forwardPage(value: number): void {
  emit('update:page', value)
}

function forwardPageSize(value: number): void {
  emit('update:pageSize', value)
}
</script>

<template>
  <section class="data-table wb-card">
    <div v-if="$slots.toolbar" class="data-table__toolbar">
      <slot name="toolbar" />
    </div>

    <ErrorState v-if="error" :message="error" @retry="emit('retry')" />

    <LoadingState v-else-if="loading && rows.length === 0" :rows="4" />

    <EmptyState
      v-else-if="!loading && rows.length === 0"
      :title="emptyTitle"
      :description="emptyDescription"
    >
      <slot name="empty-actions" />
    </EmptyState>

    <template v-else>
      <div class="wb-table">
        <el-table
          :data="rows as unknown[]"
          :row-key="rowKey"
          :stripe="stripe"
          style="width: 100%"
          @selection-change="(rows: unknown[]) => emit('selection-change', rows)"
        >
          <el-table-column v-if="selectable" type="selection" width="44" />
          <slot />
        </el-table>
      </div>
      <Pagination
        v-if="showPagination"
        :page="page"
        :page-size="pageSize"
        :total="total"
        :disabled="loading"
        @update:page="forwardPage"
        @update:page-size="forwardPageSize"
        @change="emit('refresh')"
      />
    </template>
  </section>
</template>

<style scoped>
.data-table {
  padding: 14px 16px 10px;
}

.data-table__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
</style>
