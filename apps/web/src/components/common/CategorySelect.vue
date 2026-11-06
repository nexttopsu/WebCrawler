<script setup lang="ts">
/**
 * 栏目通用选择器。
 *
 * 把栏目树扁平化在一个下拉里：同级按排序值排列，子级用「└」逐级缩进，
 * 例如：
 *   关于我们
 *   　└ 剧院介绍
 *   剧院动态
 *   　└ 儿艺新闻
 *   　　└ 公告1
 *
 * 选中后输入框显示完整路径（「剧院动态 / 儿艺新闻」），搜索时按路径匹配；
 * 未限定站点时选项带站点名前缀。采集规则、任务创建、文章筛选、
 * 规则测试保存等所有需要选栏目的场景都使用它，保证展示与排序一致。
 */
import { computed, ref } from 'vue'
import type { SiteDto } from '@webcrawler/shared'
import { listSites } from '@/api/sites'
import { useCategoryTree } from '@/composables/useCategoryTree'

const props = withDefaults(
  defineProps<{
    modelValue: number | number[] | null | undefined
    /** 限定站点；不传则列出全部站点的栏目（选项带站点名前缀） */
    siteId?: number | null
    multiple?: boolean
    /** 多选时最多可选个数；0 表示不限制 */
    multipleLimit?: number
    clearable?: boolean
    disabled?: boolean
    filterable?: boolean
    placeholder?: string
    /** 只列出启用的栏目；停用栏目的启用子栏目仍会展示，不会整棵消失 */
    onlyEnabled?: boolean
    /** 这些栏目在下拉中置灰（例如编辑时排除自己与自己的后代） */
    excludeIds?: number[]
    /** 下拉无数据时的提示文案 */
    noDataText?: string
    /** 选择框宽度，默认撑满父容器 */
    width?: string
  }>(),
  {
    siteId: null,
    multiple: false,
    multipleLimit: 0,
    clearable: true,
    disabled: false,
    filterable: true,
    placeholder: '选择栏目',
    onlyEnabled: false,
    excludeIds: undefined,
    noDataText: '暂无栏目',
    width: '100%',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: number | number[] | null | undefined]
}>()

const { tree, load } = useCategoryTree()
const siteOptions = ref<SiteDto[]>([])

void load()
void listSites({ pageSize: 100 })
  .then((page) => {
    siteOptions.value = page.items
  })
  .catch(() => {
    siteOptions.value = []
  })

const siteNameMap = computed(() => new Map(siteOptions.value.map((site) => [site.id, site.name])))

interface FlatOption {
  value: number
  /** 下拉里的显示文案：缩进 + 名称 */
  label: string
  /** 选中后输入框 / 标签里显示的完整路径 */
  pathLabel: string
}

const options = computed<FlatOption[]>(() => {
  const result: FlatOption[] = []
  const walk = (nodes: typeof tree.value, depth: number, ancestors: string[]): void => {
    for (const node of nodes) {
      if (props.siteId && node.siteId !== props.siteId) continue
      if (!props.onlyEnabled || node.enabled) {
        // 层级用全角字符缩进，不会被 HTML 折叠
        const indent = depth === 0 ? '' : `${'　'.repeat(depth - 1)}└ `
        const name = node.enabled ? node.name : `${node.name}（已停用）`
        // 未限定站点时选项带站点名前缀，避免不同站点的同名栏目混淆
        const sitePrefix = props.siteId
          ? ''
          : `${siteNameMap.value.get(node.siteId) ?? `站点 #${node.siteId}`} / `
        const path = [...ancestors, node.name].join(' / ')
        result.push({
          value: node.id,
          label: `${sitePrefix}${indent}${name}`,
          pathLabel: `${sitePrefix}${path}`,
        })
      }
      walk(node.children, depth + 1, [...ancestors, node.name])
    }
  }
  walk(tree.value, 0, [])
  return result
})

function onUpdate(value: number | number[] | null): void {
  emit('update:modelValue', value)
}
</script>

<template>
  <el-select
    :model-value="modelValue"
    :multiple="multiple"
    :multiple-limit="multipleLimit"
    :clearable="clearable"
    :disabled="disabled"
    :filterable="filterable"
    :placeholder="placeholder"
    :no-data-text="noDataText"
    :style="{ width }"
    @update:model-value="onUpdate"
  >
    <el-option
      v-for="opt in options"
      :key="opt.value"
      :label="opt.pathLabel"
      :value="opt.value"
      :disabled="excludeIds?.includes(opt.value)"
    >
      <span class="category-select__label">{{ opt.label }}</span>
    </el-option>
  </el-select>
</template>

<style scoped>
.category-select__label {
  white-space: pre;
}
</style>
