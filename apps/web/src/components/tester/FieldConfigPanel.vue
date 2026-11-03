<script setup lang="ts">
import { computed } from 'vue'
import type { TesterFieldDraft } from '@/composables/useTesterDraft'
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue'

interface FieldPreset {
  key: string
  label: string
  type: 'text' | 'html' | 'attr'
  attribute?: string
  multiple?: boolean
  required?: boolean
}

const props = defineProps<{
  fields: TesterFieldDraft[]
  title: string
  subtitle?: string
  /** 内置字段预设；缺省为详情字段的默认预设 */
  builtIns?: FieldPreset[]
}>()

const emit = defineEmits<{
  'update:fields': [value: TesterFieldDraft[]]
}>()

const FIELD_TYPES = [
  { value: 'text', label: 'text（文本）' },
  { value: 'html', label: 'html（HTML）' },
  { value: 'attr', label: 'attr（属性）' },
] as const

/** 详情字段的默认内置预设。 */
const DEFAULT_BUILT_INS: FieldPreset[] = [
  { key: 'title', label: '标题', type: 'text', required: true },
  { key: 'content', label: '正文', type: 'html', required: true },
  { key: 'author', label: '作者', type: 'text' },
  { key: 'publishTime', label: '发布时间', type: 'text' },
  { key: 'images', label: '图片', type: 'attr', attribute: 'src', multiple: true },
]

const builtInFields = computed<FieldPreset[]>(() => props.builtIns ?? DEFAULT_BUILT_INS)

function cloneFields(): TesterFieldDraft[] {
  return props.fields.map((field) => ({ ...field }))
}

function addBuiltIn(key: string): void {
  if (props.fields.some((field) => field.key === key)) return
  const preset = builtInFields.value.find((item) => item.key === key)
  if (!preset) return
  emit('update:fields', [
    ...cloneFields(),
    {
      key: preset.key,
      label: preset.label,
      selector: '',
      type: preset.type,
      attribute: preset.attribute ?? '',
      multiple: preset.multiple === true,
      required: preset.required === true,
      defaultValue: '',
      trim: true,
      collapseWhitespace: false,
      enabled: true,
    },
  ])
}

function addCustom(): void {
  let index = props.fields.filter((field) => field.key.startsWith('custom_')).length + 1
  let key = `custom_${index}`
  while (props.fields.some((field) => field.key === key)) {
    index += 1
    key = `custom_${index}`
  }
  emit('update:fields', [
    ...cloneFields(),
    {
      key,
      label: '',
      selector: '',
      type: 'text',
      attribute: '',
      multiple: false,
      required: false,
      defaultValue: '',
      trim: true,
      collapseWhitespace: false,
      enabled: true,
    },
  ])
}

function removeField(index: number): void {
  emit('update:fields', cloneFields().filter((_, i) => i !== index))
}

function moveField(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= props.fields.length) return
  const next = cloneFields()
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  emit('update:fields', next)
}

const availableBuiltIns = (): Array<{ key: string; label: string }> =>
  builtInFields.value.filter((item) => !props.fields.some((field) => field.key === item.key)).map((item) => ({
    key: item.key,
    label: `${item.label}（${item.key}）`,
  }))
</script>

<template>
  <div class="field-panel">
    <div class="panel-head">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <div class="panel-actions">
        <el-dropdown v-if="availableBuiltIns().length > 0" trigger="click" @command="addBuiltIn">
          <el-button size="small">添加内置字段</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="item in availableBuiltIns()" :key="item.key" :command="item.key">
                {{ item.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button size="small" type="primary" plain :icon="Plus" @click="addCustom">自定义</el-button>
      </div>
    </div>

    <p v-if="fields.length === 0" class="empty">尚未配置字段，请从内置字段开始，或在预览中点选元素。</p>

    <el-collapse v-else>
      <el-collapse-item v-for="(field, index) in fields" :key="field.key" :name="field.key">
        <template #title>
          <span class="field-title" :class="{ 'is-disabled': !field.enabled }">
            <code>{{ field.key }}</code>
            <span v-if="field.label">{{ field.label }}</span>
            <el-tag v-if="field.required" size="small" type="danger" effect="plain">必填</el-tag>
            <el-tag v-if="!field.enabled" size="small" type="info" effect="plain">停用</el-tag>
          </span>
        </template>

        <div class="field-grid">
          <label>
            <span>字段 key</span>
            <el-input v-model="field.key" size="small" placeholder="title" />
          </label>
          <label>
            <span>显示名称</span>
            <el-input v-model="field.label" size="small" placeholder="标题" />
          </label>
          <label class="span-2">
            <span>Selector</span>
            <el-input v-model="field.selector" size="small" placeholder=".article-title" />
          </label>
          <label>
            <span>提取类型</span>
            <el-select v-model="field.type" size="small">
              <el-option v-for="item in FIELD_TYPES" :key="item.value" :value="item.value" :label="item.label" />
            </el-select>
          </label>
          <label>
            <span>属性名（attr）</span>
            <el-input v-model="field.attribute" size="small" :disabled="field.type !== 'attr'" placeholder="src" />
          </label>
          <div class="span-2 switches">
            <el-checkbox v-model="field.multiple" size="small">多值</el-checkbox>
            <el-checkbox v-model="field.required" size="small">必填</el-checkbox>
            <el-checkbox v-model="field.trim" size="small">去首尾空白</el-checkbox>
            <el-checkbox v-model="field.collapseWhitespace" size="small">折叠空白</el-checkbox>
            <el-checkbox v-model="field.enabled" size="small">启用</el-checkbox>
          </div>
          <label class="span-2">
            <span>默认值（缺失时兜底）</span>
            <el-input v-model="field.defaultValue" size="small" placeholder="佚名" />
          </label>
        </div>

        <div class="field-actions">
          <el-button size="small" text :icon="ArrowUp" :disabled="index === 0" @click="moveField(index, -1)" />
          <el-button
            size="small"
            text
            :icon="ArrowDown"
            :disabled="index === fields.length - 1"
            @click="moveField(index, 1)"
          />
          <el-button size="small" text type="danger" :icon="Trash2" @click="removeField(index)">删除</el-button>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<style scoped>
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.panel-head h3 {
  margin: 0;
  font-size: 13px;
}

.panel-head p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.panel-actions {
  display: flex;
  gap: 6px;
}

.empty {
  font-size: 12px;
  color: var(--wb-text-muted);
  padding: 12px 0;
}

.field-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.field-title code {
  color: var(--wb-primary);
}

.field-title.is-disabled {
  opacity: 0.5;
}

.field-grid {
  display: grid;
  /* 中栏可拖拽变窄：auto-fit 让两列在窄屏自动落成一列，而不是把控件挤到重叠 */
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 12px;
}

.field-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-secondary);
  min-width: 0;
}

.field-grid .span-2 {
  grid-column: 1 / -1;
}

.switches {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px !important;
}

.switches :deep(.el-checkbox) {
  margin-right: 0;
}

.field-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
</style>
