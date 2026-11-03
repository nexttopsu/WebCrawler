<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CategorySummaryDto, CrawlRuleConfig, RuleSummaryDto, SiteDto } from '@webcrawler/shared'
import { ElMessage } from 'element-plus'
import { Download, Save, Upload } from '@lucide/vue'
import {
  createRule,
  listCategories,
  listProxies,
  listRules,
  listSites,
  updateRule,
  validateRuleConfig,
  type ProxyItem,
} from '@/api/tester'

const props = defineProps<{
  /** 当前配置（与 Rule Schema 同构），保存/校验/导出都用它 */
  config: CrawlRuleConfig | null
}>()

const emit = defineEmits<{
  /** 保存成功（新建或更新），参数为规则 id */
  saved: [ruleId: number]
  /** 导入 JSON 完成，父组件需要把配置应用到界面 */
  imported: [config: CrawlRuleConfig]
}>()

/* ------------------------------ 关联数据 ------------------------------ */

const sites = ref<SiteDto[]>([])
const categories = ref<CategorySummaryDto[]>([])
const rules = ref<RuleSummaryDto[]>([])
const proxies = ref<ProxyItem[]>([])

const siteId = ref<number | null>(null)
const categoryId = ref<number | null>(null)
const ruleName = ref('')
const ruleDescription = ref('')
const saveMode = ref<'create' | 'update'>('create')
const updateTargetId = ref<number | null>(null)
const saving = ref(false)
const validating = ref(false)

onMounted(async () => {
  try {
    const [sitePage, proxyResult] = await Promise.all([
      listSites(),
      listProxies().catch(() => ({ items: [], total: 0 })),
    ])
    sites.value = sitePage.items
    proxies.value = proxyResult.items
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '加载站点/代理列表失败')
  }
})

watch(siteId, async (value) => {
  categoryId.value = null
  rules.value = []
  if (!value) return
  try {
    const [categoryPage, rulePage] = await Promise.all([listCategories(value), listRules(value)])
    categories.value = categoryPage.items
    rules.value = rulePage.items
  } catch {
    ElMessage.warning('加载栏目/规则列表失败')
  }
})

/* ------------------------------ 保存 ------------------------------ */

const canSave = computed(
  () =>
    props.config !== null &&
    ruleName.value.trim().length > 0 &&
    siteId.value != null &&
    (saveMode.value === 'create' || updateTargetId.value != null),
)

async function save(): Promise<void> {
  if (!canSave.value || !props.config) return
  saving.value = true
  try {
    if (saveMode.value === 'create') {
      const created = await createRule({
        siteId: siteId.value!,
        ...(categoryId.value ? { categoryId: categoryId.value! } : {}),
        name: ruleName.value.trim(),
        config: props.config,
        ...(ruleDescription.value.trim() ? { description: ruleDescription.value.trim() } : {}),
      })
      ElMessage.success(`规则已创建（v${created.version}）`)
      emit('saved', created.id)
    } else {
      const updated = await updateRule(updateTargetId.value!, {
        config: props.config,
        ...(ruleName.value.trim() ? { name: ruleName.value.trim() } : {}),
      })
      ElMessage.success(`规则已更新（v${updated.version}）`)
      emit('saved', updated.id)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function validate(): Promise<void> {
  if (!props.config) {
    ElMessage.warning('当前没有可校验的配置')
    return
  }
  validating.value = true
  try {
    const result = await validateRuleConfig(props.config)
    if (result.valid) {
      ElMessage.success('规则配置通过 Schema 校验')
    } else {
      const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')
      ElMessage.error(`校验失败：${summary}`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '校验失败')
  } finally {
    validating.value = false
  }
}

/* ------------------------------ 导入 / 导出 ------------------------------ */

const fileInputRef = ref<HTMLInputElement | null>(null)

function exportJson(): void {
  if (!props.config) {
    ElMessage.warning('当前没有可导出的配置')
    return
  }
  const blob = new Blob([JSON.stringify(props.config, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `webcrawler-rule-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function importJson(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed: unknown = JSON.parse(String(reader.result))
      if (typeof parsed !== 'object' || parsed === null) throw new Error('不是 JSON 对象')
      emit('imported', parsed as CrawlRuleConfig)
      ElMessage.success('已导入，请在界面确认后保存')
    } catch (error) {
      ElMessage.error(`导入失败：${error instanceof Error ? error.message : '文件解析失败'}`)
    }
  }
  reader.readAsText(file)
}
</script>

<template>
  <div class="save-panel">
    <div class="row">
      <label>
        <span>关联网站</span>
        <el-select v-model="siteId" size="small" placeholder="选择站点" filterable>
          <el-option v-for="site in sites" :key="site.id" :value="site.id" :label="site.name" />
        </el-select>
      </label>
      <label>
        <span>关联栏目（可选）</span>
        <el-select v-model="categoryId" size="small" placeholder="不关联" clearable :disabled="!siteId">
          <el-option v-for="category in categories" :key="category.id" :value="category.id" :label="category.name" />
        </el-select>
      </label>
    </div>

    <div class="row">
      <label>
        <span>规则名称</span>
        <el-input v-model="ruleName" size="small" placeholder="示例站新闻规则" />
      </label>
      <label>
        <span>描述（可选）</span>
        <el-input v-model="ruleDescription" size="small" placeholder="备注" />
      </label>
    </div>

    <div class="row">
      <el-radio-group v-model="saveMode" size="small">
        <el-radio-button value="create">保存为新规则</el-radio-button>
        <el-radio-button value="update">更新已有规则</el-radio-button>
      </el-radio-group>
      <el-select
        v-if="saveMode === 'update'"
        v-model="updateTargetId"
        size="small"
        placeholder="选择要更新的规则"
        filterable
      >
        <el-option
          v-for="rule in rules"
          :key="rule.id"
          :value="rule.id"
          :label="`#${rule.id} ${rule.name} (v${rule.version})`"
        />
      </el-select>
    </div>

    <div class="actions">
      <el-button type="primary" size="small" :icon="Save" :loading="saving" :disabled="!canSave" @click="save">
        保存规则
      </el-button>
      <el-button size="small" :loading="validating" @click="validate">校验 Schema</el-button>
      <el-button size="small" :icon="Upload" @click="fileInputRef?.click()">导入 JSON</el-button>
      <el-button size="small" :icon="Download" @click="exportJson">导出 JSON</el-button>
      <input ref="fileInputRef" type="file" accept=".json,application/json" hidden @change="importJson" />
    </div>

    <p class="hint">草稿会自动保存到本地（不含代理凭据），刷新页面后自动恢复。</p>
  </div>
</template>

<style scoped>
.save-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid var(--wb-border);
  background: var(--wb-surface-muted);
}

.row {
  display: flex;
  gap: 10px;
}

.row label {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-secondary);
  min-width: 0;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--wb-text-muted);
}
</style>
