<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listProxies, type ProxyItem } from '@/api/tester'

/**
 * 代理选择器（只读）。
 *
 * 单独成组件的原因：模板中的 v-for 选项只在独立 SFC 内做类型推导，
 * 同时这里统一处理「加载失败就当作直连」的降级，不阻塞测试器主流程。
 */
const model = defineModel<number | null>({ default: null })

const proxies = ref<ProxyItem[]>([])

function proxyLabel(option: ProxyItem): string {
  return `#${option.id} ${option.type}://${option.host}:${option.port}`
}

onMounted(async () => {
  try {
    proxies.value = (await listProxies()).items
  } catch {
    // 代理接口不可用时只保留「直连」
  }
})
</script>

<template>
  <el-select v-model="model" class="proxy-select" placeholder="直连" clearable>
    <el-option v-for="option in proxies" :key="option.id" :value="option.id" :label="proxyLabel(option)" />
  </el-select>
</template>

<style scoped>
.proxy-select {
  width: 200px;
}
</style>
