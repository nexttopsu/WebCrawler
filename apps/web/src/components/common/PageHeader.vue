<script setup lang="ts">
/**
 * 页面标题区：标题 + 说明 + 右侧操作。
 * 与顶栏的面包屑分工：面包屑给层级，这里给当前页的语气与主操作。
 */
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <header class="page-header">
    <div class="page-header__text">
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.page-header__text h1 {
  font-size: 19px;
  font-weight: 650;
  letter-spacing: 0.2px;
}

.page-header__text p {
  margin-top: 4px;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.page-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
