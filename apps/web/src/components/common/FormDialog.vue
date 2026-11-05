<script setup lang="ts">
/**
 * 表单弹窗：统一标题、宽度、提交态与底部按钮。
 * 表单本身由页面通过默认插槽提供，校验也在页面内用 el-form 完成。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    width?: number
    submitText?: string
    cancelText?: string
    loading?: boolean
    /** 只读弹窗：隐藏确定按钮 */
    readonly?: boolean
    description?: string
  }>(),
  {
    width: 520,
    submitText: '保存',
    cancelText: '取消',
    loading: false,
    readonly: false,
    description: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  submit: []
  closed: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

function close(): void {
  visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title"
    :width="width"
    align-center
    destroy-on-close
    append-to-body
    @closed="emit('closed')"
  >
    <p v-if="description" class="form-dialog__desc">{{ description }}</p>
    <slot />

    <template #footer>
      <div class="form-dialog__footer">
        <div class="form-dialog__footer-extra">
          <slot name="footer-extra" />
        </div>
        <div class="form-dialog__footer-actions">
          <el-button :disabled="loading" @click="close">{{ readonly ? '关闭' : cancelText }}</el-button>
          <el-button v-if="!readonly" type="primary" :loading="loading" @click="emit('submit')">
            {{ submitText }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-dialog__desc {
  margin-bottom: 12px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
  line-height: 1.7;
}

.form-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.form-dialog__footer-extra,
.form-dialog__footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
