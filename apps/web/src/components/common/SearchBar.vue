<script setup lang="ts">
/**
 * 搜索框：输入即搜（去抖 300ms）+ 回车立即搜 + 清空。
 * 受控组件，值由父级持有，便于把搜索词一起带进分页请求。
 *
 * 清空只用 el-input 自带的 clearable，不要再往 suffix 里塞 ✕：
 * 那样输入内容后会同时出现自带的圆圈 ✕ 和自定义图标两个清除按钮。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { Search } from '@lucide/vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    width?: number
    debounce?: number
  }>(),
  { placeholder: '搜索…', width: 240, debounce: 300 },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  search: [value: string]
}>()

const inner = ref(props.modelValue)
let timer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.modelValue,
  (value) => {
    if (value !== inner.value) inner.value = value
  },
)

function schedule(value: string): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => emit('search', value), props.debounce)
}

function onInput(value: string): void {
  inner.value = value
  emit('update:modelValue', value)
  schedule(value)
}

function onSubmit(): void {
  if (timer) clearTimeout(timer)
  emit('search', inner.value)
}

function clear(): void {
  inner.value = ''
  emit('update:modelValue', '')
  emit('search', '')
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <el-input
    :model-value="inner"
    :placeholder="placeholder"
    :style="{ width: `${width}px` }"
    clearable
    @update:model-value="onInput"
    @keyup.enter="onSubmit"
    @clear="clear"
  >
    <template #prefix>
      <Search :size="15" />
    </template>
  </el-input>
</template>
