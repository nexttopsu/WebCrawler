<script setup lang="ts">
/** 分页条：统一分页参数与布局，避免每页各写一套。 */
withDefaults(
  defineProps<{
    page: number
    pageSize: number
    total: number
    pageSizes?: number[]
    disabled?: boolean
  }>(),
  { pageSizes: () => [10, 20, 50, 100], disabled: false },
)

const emit = defineEmits<{
  'update:page': [value: number]
  'update:pageSize': [value: number]
  change: []
}>()

function onPage(value: number): void {
  emit('update:page', value)
  emit('change')
}

function onSize(value: number): void {
  emit('update:pageSize', value)
  emit('update:page', 1)
  emit('change')
}
</script>

<template>
  <div v-if="total > 0" class="pagination">
    <el-pagination
      background
      :current-page="page"
      :page-size="pageSize"
      :page-sizes="pageSizes"
      :total="total"
      :disabled="disabled"
      layout="total, sizes, prev, pager, next, jumper"
      @update:current-page="onPage"
      @update:page-size="onSize"
    />
  </div>
</template>

<style scoped>
.pagination {
  display: flex;
  justify-content: flex-end;
  padding: 12px 4px 2px;
}

@media (max-width: 720px) {
  .pagination {
    justify-content: center;
  }
}
</style>
