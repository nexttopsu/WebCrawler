<script setup lang="ts">
/**
 * 接口文档（类 Swagger）。
 *
 * 文档内容来自 `@webcrawler/shared` 的 `OPEN_API_DOC`——与服务端
 * `GET /api/open/docs` 是同一份常量，不存在「页面写的和接口不一致」。
 *
 * 右侧的在线调试用手写 `fetch` 而不是项目的 axios 封装：这里要展示真实的
 * HTTP 状态码与原始响应体（axios 封装会把错误归一成中文文案），
 * 调试面板看到的就是第三方对接方实际拿到的东西。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Copy, ExternalLink, Play, RotateCcw } from '@lucide/vue'
import { OPEN_API_DOC, type OpenApiEndpointDoc, type OpenApiParamDoc } from '@webcrawler/shared'
import { API_BASE_URL } from '@/api/client'
import PageHeader from '@/components/common/PageHeader.vue'
import JsonViewer from '@/components/common/JsonViewer.vue'

const doc = OPEN_API_DOC

const activeId = ref(doc.endpoints[0].id)
const active = computed<OpenApiEndpointDoc>(
  () => doc.endpoints.find((endpoint) => endpoint.id === activeId.value) ?? doc.endpoints[0],
)

/** 调试表单的值，键是参数名；切换接口时整体重置。 */
const values = reactive<Record<string, string>>({})
const sending = ref(false)
const copiedKey = ref<string | null>(null)

interface DebugResult {
  ok: boolean
  status: number
  statusText: string
  elapsedMs: number
  size: number
  body: unknown
}

const result = ref<DebugResult | null>(null)

/**
 * 服务端所有接口都挂在 `/api` 前缀下；前端 `API_BASE_URL` 默认就是 `/api`，
 * 但生产可能指向独立域名或别的挂载点，所以拼地址时先剥掉服务端前缀再拼上它，
 * 避免出现 `/api/api/open/...` 这样的双重前缀。
 */
const API_MOUNT = '/api'

function toRequestPath(serverPath: string): string {
  const rest = serverPath.startsWith(API_MOUNT) ? serverPath.slice(API_MOUNT.length) : serverPath
  return `${API_BASE_URL}${rest}`
}

/** 接口根地址（以当前前端能访问到的形式展示）。 */
const docRoot = computed(() => toRequestPath(doc.baseUrl))

function resetParams(): void {
  for (const key of Object.keys(values)) delete values[key]
  for (const param of active.value.params) values[param.name] = param.defaultValue ?? ''
  result.value = null
}

watch(activeId, resetParams, { immediate: true })

/** 把路径参数与查询参数拼成可复制的请求地址。 */
function buildUrl(): string {
  const endpoint = active.value
  let path = endpoint.path
  const search = new URLSearchParams()

  for (const param of endpoint.params) {
    const raw = (values[param.name] ?? '').trim()
    if (param.location === 'path') {
      path = path.replace(`:${param.name}`, encodeURIComponent(raw))
      continue
    }
    if (raw) search.set(param.name, raw)
  }

  const query = search.toString()
  return `${toRequestPath(path)}${query ? `?${query}` : ''}`
}

const requestUrl = computed(() => buildUrl())

const absoluteUrl = computed(() => {
  try {
    return new URL(requestUrl.value, window.location.origin).toString()
  } catch {
    return requestUrl.value
  }
})

const curlSnippet = computed(() => `curl -s "${absoluteUrl.value}"`)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function send(): Promise<void> {
  const endpoint = active.value
  const missing = endpoint.params.find(
    (param) => param.required && !(values[param.name] ?? '').trim(),
  )
  if (missing) {
    ElMessage.warning(`请先填写 ${missing.name}`)
    return
  }

  sending.value = true
  result.value = null
  const started = performance.now()

  try {
    const response = await fetch(requestUrl.value, { headers: { accept: 'application/json' } })
    const text = await response.text()
    const elapsedMs = Math.round(performance.now() - started)

    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // 非 JSON（例如反向代理返回的 HTML 错误页）原样展示，便于定位部署问题
    }

    result.value = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || (response.ok ? 'OK' : ''),
      elapsedMs,
      size: new Blob([text]).size,
      body,
    }
  } catch (error) {
    result.value = {
      ok: false,
      status: 0,
      statusText: '网络错误',
      elapsedMs: Math.round(performance.now() - started),
      size: 0,
      body: {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    }
  } finally {
    sending.value = false
  }
}

async function copy(text: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    ElMessage.success('已复制到剪贴板')
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null
    }, 1600)
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选择复制')
  }
}

function selectEndpoint(id: string): void {
  activeId.value = id
}

/**
 * 示例页面是 `public/open-api-demo.html`（纯静态，不打包）。
 *
 * 用相对 BASE_URL 拼而不是写死 `/open-api-demo.html`：子路径部署（如 `/admin/`）时也能打开。
 */
const DEMO_PATH = `${import.meta.env.BASE_URL}open-api-demo.html`

function openDemo(): void {
  window.open(DEMO_PATH, '_blank', 'noopener')
}

function paramTypeLabel(param: OpenApiParamDoc): string {
  if (param.type === 'enum') return param.enumValues?.join(' / ') ?? 'enum'
  return param.type
}
</script>

<template>
  <div class="view">
    <PageHeader
      title="接口文档"
      description="对外开放的只读接口，供第三方系统拉取网站、栏目与文章数据；不写入数据库，也不需要登录。"
    >
      <template #actions>
        <el-button @click="copy(docRoot, 'root')">
          <component :is="copiedKey === 'root' ? Check : Copy" :size="14" />
          <span>复制接口根地址</span>
        </el-button>
        <el-button type="primary" @click="openDemo">
          <ExternalLink :size="14" />
          <span>接口示例页面</span>
        </el-button>
      </template>
    </PageHeader>

    <section class="wb-card intro">
      <div class="intro__head">
        <span class="wb-tag wb-tag--primary">v{{ doc.version }}</span>
        <h2 class="intro__title">{{ doc.title }}</h2>
      </div>
      <p class="intro__desc">{{ doc.description }}</p>

      <dl class="wb-kv intro__kv">
        <dt>接口根地址</dt>
        <dd class="wb-mono">{{ docRoot }}</dd>
        <dt>请求方法</dt>
        <dd>全部为 <code class="wb-mono">GET</code>，其它方法返回 405</dd>
        <dt>鉴权</dt>
        <dd>{{ doc.authorization }}</dd>
        <dt>机器可读</dt>
        <dd class="wb-mono">GET {{ doc.baseUrl }}/docs</dd>
      </dl>

      <ul class="conventions">
        <li v-for="rule in doc.conventions" :key="rule">{{ rule }}</li>
      </ul>
    </section>

    <div class="doc-body">
      <aside class="doc-nav">
        <p class="doc-nav__title">接口列表</p>
        <button
          v-for="endpoint in doc.endpoints"
          :key="endpoint.id"
          type="button"
          class="doc-nav__item"
          :class="{ 'is-active': endpoint.id === activeId }"
          @click="selectEndpoint(endpoint.id)"
        >
          <span class="method">GET</span>
          <span class="doc-nav__path wb-mono">{{ endpoint.path }}</span>
          <span class="doc-nav__label">{{ endpoint.title }}</span>
        </button>
      </aside>

      <div class="doc-main">
        <section class="wb-card">
          <div class="ep-head">
            <span class="method">GET</span>
            <code class="ep-path wb-mono">{{ active.path }}</code>
            <span class="ep-copy">
              <button type="button" class="ghost-btn" @click="copy(active.path, 'path')">
                <component :is="copiedKey === 'path' ? Check : Copy" :size="12" />
                复制
              </button>
            </span>
          </div>
          <h2 class="ep-title">{{ active.title }}</h2>
          <p class="ep-summary">{{ active.summary }}</p>
          <ul v-if="active.notes.length" class="notes">
            <li v-for="note in active.notes" :key="note">{{ note }}</li>
          </ul>
        </section>

        <section v-if="active.params.length" class="wb-card">
          <h3 class="section-title">请求参数</h3>
          <div class="table-wrap">
            <table class="doc-table">
              <thead>
                <tr>
                  <th>参数</th>
                  <th>位置</th>
                  <th>类型</th>
                  <th>必填</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="param in active.params" :key="param.name">
                  <td class="wb-mono param-name">{{ param.name }}</td>
                  <td>{{ param.location }}</td>
                  <td class="wb-mono">{{ paramTypeLabel(param) }}</td>
                  <td>
                    <span class="flag" :class="param.required ? 'is-required' : 'is-optional'">
                      {{ param.required ? '必填' : '可选' }}
                    </span>
                  </td>
                  <td>
                    {{ param.description }}
                    <span v-if="param.defaultValue !== undefined" class="wb-muted">
                      （默认 {{ param.defaultValue }}）
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="wb-card">
          <div class="section-head">
            <h3 class="section-title section-title--flush">在线调试</h3>
            <span class="hint">请求会真实发往当前后端，只读接口不会改动数据</span>
          </div>

          <div v-if="active.params.length" class="debug-form">
            <label v-for="param in active.params" :key="param.name" class="debug-field">
              <span class="debug-field__label">
                {{ param.name }}
                <em>{{ param.location }}{{ param.required ? ' · 必填' : '' }}</em>
              </span>

              <el-select
                v-if="param.type === 'enum'"
                v-model="values[param.name]"
                size="default"
                style="width: 100%"
              >
                <el-option
                  v-for="option in param.enumValues ?? []"
                  :key="option"
                  :label="option"
                  :value="option"
                />
              </el-select>

              <el-input
                v-else
                v-model="values[param.name]"
                :placeholder="param.placeholder ?? `请输入 ${param.name}`"
                clearable
                @keyup.enter="send"
              />
            </label>
          </div>
          <p v-else class="hint">该接口不需要参数。</p>

          <div class="debug-actions">
            <el-button type="primary" :loading="sending" @click="send">
              <Play :size="14" />
              <span>发送请求</span>
            </el-button>
            <el-button :disabled="sending" @click="resetParams">
              <RotateCcw :size="14" />
              <span>重置参数</span>
            </el-button>
          </div>

          <div class="snippet">
            <div class="snippet__bar">
              <span>请求地址</span>
              <button type="button" class="ghost-btn" @click="copy(absoluteUrl, 'url')">
                <component :is="copiedKey === 'url' ? Check : Copy" :size="12" />
                复制
              </button>
            </div>
            <pre class="wb-code snippet__body">{{ absoluteUrl }}</pre>
          </div>

          <div class="snippet">
            <div class="snippet__bar">
              <span>cURL</span>
              <button type="button" class="ghost-btn" @click="copy(curlSnippet, 'curl')">
                <component :is="copiedKey === 'curl' ? Check : Copy" :size="12" />
                复制
              </button>
            </div>
            <pre class="wb-code snippet__body">{{ curlSnippet }}</pre>
          </div>

          <div v-if="result" class="result">
            <div class="result__bar">
              <span class="status" :class="result.ok ? 'is-ok' : 'is-bad'">
                {{ result.status || 'ERR' }}
                {{ result.statusText }}
              </span>
              <span class="wb-muted">
                耗时 {{ result.elapsedMs }} ms · {{ formatSize(result.size) }}
              </span>
            </div>
            <JsonViewer :value="result.body" :max-height="460" />
          </div>
        </section>

        <section class="wb-card">
          <h3 class="section-title">响应字段</h3>

          <template v-if="active.response.wrapperFields">
            <p class="hint">data 为分页对象：</p>
            <div class="table-wrap">
              <table class="doc-table">
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>类型</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="field in active.response.wrapperFields" :key="field.name">
                    <td class="wb-mono param-name">{{ field.name }}</td>
                    <td class="wb-mono">{{ field.type }}</td>
                    <td>{{ field.description }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="hint hint--spaced">items 的每个元素：</p>
          </template>
          <p v-else-if="active.response.kind === 'array'" class="hint">data 直接是数组（不分页），每个元素：</p>

          <div class="table-wrap">
            <table class="doc-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>类型</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="field in active.response.fields" :key="field.name">
                  <td class="wb-mono param-name">{{ field.name }}</td>
                  <td class="wb-mono">{{ field.type }}</td>
                  <td>{{ field.description }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <template v-if="active.response.nested">
            <p class="hint hint--spaced">{{ active.response.nested.label }}</p>
            <div class="table-wrap">
              <table class="doc-table">
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>类型</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="field in active.response.nested.fields" :key="field.name">
                    <td class="wb-mono param-name">{{ field.name }}</td>
                    <td class="wb-mono">{{ field.type }}</td>
                    <td>{{ field.description }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>

        <section class="wb-card">
          <div class="section-head">
            <h3 class="section-title section-title--flush">响应示例</h3>
            <span class="hint">示例数据仅用于说明结构</span>
          </div>
          <JsonViewer :value="active.exampleResponse" :max-height="400" />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------------- 顶部说明 ---------------- */
.intro__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.intro__title {
  font-size: 15px;
  font-weight: 650;
}

.intro__desc {
  margin-top: 8px;
  font-size: 13px;
  color: var(--wb-text-secondary);
  line-height: 1.7;
}

.intro__kv {
  margin-top: 14px;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: baseline;
}

.conventions {
  margin: 14px 0 0;
  padding: 12px 14px 12px 30px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-muted);
  border: 1px solid var(--wb-border);
  font-size: 12.5px;
  color: var(--wb-text-secondary);
  line-height: 1.85;
  word-break: break-word;
}

/* ---------------- 左右布局 ---------------- */
.doc-body {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.doc-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 12px;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  box-shadow: var(--wb-shadow-sm);
}

.doc-nav__title {
  padding: 0 8px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--wb-text-muted);
}

.doc-nav__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.doc-nav__item:hover {
  background: var(--wb-surface-muted);
}

.doc-nav__item.is-active {
  background: var(--wb-primary-soft);
  border-color: transparent;
}

.doc-nav__path {
  color: var(--wb-text);
  font-size: 12px;
  word-break: break-all;
}

.doc-nav__item.is-active .doc-nav__path {
  color: var(--wb-primary);
  font-weight: 600;
}

.doc-nav__label {
  grid-column: 2;
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.doc-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

/* ---------------- 接口标题 ---------------- */
.method {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 42px;
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--wb-success-soft);
  color: var(--wb-success);
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4px;
}

.ep-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-muted);
  border: 1px solid var(--wb-border);
}

.ep-path {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--wb-text);
  word-break: break-all;
}

.ep-copy {
  flex: 0 0 auto;
}

.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
  color: var(--wb-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.ghost-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}

.ep-title {
  margin-top: 12px;
  font-size: 14px;
  font-weight: 650;
}

.ep-summary {
  margin-top: 4px;
  font-size: 13px;
  color: var(--wb-text-secondary);
  line-height: 1.7;
}

.notes {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
  line-height: 1.8;
}

/* ---------------- 表格 ---------------- */
.section-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.2px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--wb-border);
  margin-bottom: 12px;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.section-title--flush {
  border-bottom: none;
  padding-bottom: 0;
  margin-bottom: 0;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
}

.doc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.doc-table th {
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  color: var(--wb-text-secondary);
  background: var(--wb-surface-muted);
  border-bottom: 1px solid var(--wb-border);
  white-space: nowrap;
}

.doc-table td {
  padding: 8px 10px;
  vertical-align: top;
  color: var(--wb-text-secondary);
  border-bottom: 1px dashed var(--wb-border);
  line-height: 1.6;
}

.doc-table tbody tr:last-child td {
  border-bottom: none;
}

.param-name {
  color: var(--wb-text);
  white-space: nowrap;
}

.flag {
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 19px;
  white-space: nowrap;
}

.flag.is-required {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

.flag.is-optional {
  background: var(--wb-neutral-soft);
  color: var(--wb-neutral);
}

/* ---------------- 调试 ---------------- */
.hint {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.hint--spaced {
  margin: 14px 0 8px;
  color: var(--wb-text-secondary);
}

.debug-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px 14px;
}

.debug-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.debug-field__label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--wb-text);
}

.debug-field__label em {
  margin-left: 6px;
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: var(--wb-text-muted);
}

.debug-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.snippet {
  margin-top: 12px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
  overflow: hidden;
}

.snippet__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  background: var(--wb-surface);
  border-bottom: 1px solid var(--wb-border);
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.snippet__body {
  border: none;
  border-radius: 0;
  font-size: 12px;
}

.result {
  margin-top: 14px;
}

.result__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
}

.status {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 11.5px;
  font-weight: 600;
}

.status.is-ok {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}

.status.is-bad {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

@media (max-width: 1100px) {
  .doc-body {
    grid-template-columns: 1fr;
  }

  .doc-nav {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 6px;
  }

  .doc-nav__title {
    width: 100%;
  }

  .doc-nav__item {
    flex: 1 1 200px;
  }
}
</style>
