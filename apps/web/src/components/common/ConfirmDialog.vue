<script setup lang="ts">
/** 二次确认弹窗：删除、取消任务这类不可逆操作前使用。 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title?: string
    message?: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    loading?: boolean
    /** 只提示不动作：前置校验已判定无法继续时置灰确认按钮 */
    confirmDisabled?: boolean
    width?: number
  }>(),
  {
    title: '确认操作',
    message: '',
    confirmText: '确定',
    cancelText: '取消',
    danger: false,
    loading: false,
    confirmDisabled: false,
    width: 420,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

function cancel(): void {
  visible.value = false
  emit('cancel')
}
</script>

<template>
  <el-dialog v-model="visible" :title="null" :width="width" align-center append-to-body>
    <div class="confirm">
      <p class="confirm__title">{{ title }}</p>
      <slot>
        <p class="confirm__message">{{ message }}</p>
      </slot>
    </div>

    <template #footer>
      <el-button :disabled="loading" @click="cancel">{{ cancelText }}</el-button>
      <el-button :type="danger ? 'danger' : 'primary'" :loading="loading" :disabled="confirmDisabled" @click="emit('confirm')">
        {{ confirmText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.confirm {
  padding: 4px 2px 0;
}

.confirm__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text);
}

.confirm__message {
  margin-top: 8px;
  font-size: 13px;
  color: var(--wb-text-secondary);
  line-height: 1.7;
}
</style>
