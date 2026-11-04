<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { TriangleAlert } from '@lucide/vue'

const route = useRoute()

/** 当前视图的渲染异常信息；null 表示正常。 */
const crash = ref<string | null>(null)

/**
 * 视图渲染异常的兜底。
 *
 * 一个字段取到 `undefined` 就整棵渲染树失败、页面变白，代价太大：
 * 这里接住异常，换成可恢复的提示，切到别的路由自动复位，不用刷新。
 *
 * 返回 `false` 表示不再向上冒泡；`main.ts` 里的 `errorHandler` 仍会打印堆栈。
 */
onErrorCaptured((error) => {
  // 完整堆栈进控制台，界面上只给一句人话
  console.error('[view] 渲染异常', error)
  crash.value = error instanceof Error ? error.message : String(error)
  return false
})

// 换页面就复位，避免一次失败把后续路由也一起挡住
watch(
  () => route.fullPath,
  () => {
    crash.value = null
  },
)
</script>

<template>
  <div v-if="crash" class="app-crash">
    <div class="app-crash__card">
      <span class="app-crash__icon"><TriangleAlert :size="26" /></span>
      <h2>这个页面出错了</h2>
      <p class="app-crash__message">{{ crash }}</p>
      <p class="app-crash__hint">
        常见原因是某个字段为空。可以先重试一次，或者回到首页继续操作；测试器草稿会自动保存，不会丢。
      </p>
      <div class="app-crash__actions">
        <el-button size="small" @click="crash = null">重试</el-button>
        <el-button size="small" type="primary" @click="$router.push('/')">回到首页</el-button>
      </div>
    </div>
  </div>
  <RouterView v-else />
</template>

<style scoped>
.app-crash {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--wb-bg);
}

.app-crash__card {
  width: min(520px, 100%);
  padding: 28px 32px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-shadow-sm);
  text-align: center;
}

.app-crash__icon {
  display: inline-flex;
  padding: 10px;
  border-radius: 50%;
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.app-crash__card h2 {
  margin: 12px 0 10px;
  font-size: 17px;
  font-weight: 600;
  color: var(--wb-text);
}

.app-crash__message {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--wb-danger);
  word-break: break-word;
}

.app-crash__hint {
  margin: 0 0 18px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.app-crash__actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}
</style>
