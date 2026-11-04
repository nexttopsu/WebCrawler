/**
 * 可视化规则测试器服务（第四阶段）。
 *
 * 与第三阶段的 rule-test-service 的区别：这里的测试对象是「还没有保存的规则」——
 * 用户在界面上点选 DOM、临时拼出规则，直接交给真实引擎试跑。
 *
 * 铁律：测试器不另写一套解析逻辑。
 * - 列表测试走 `CrawlEngine.listPage`（与正式采集同一函数）；
 * - 详情测试走 `CrawlEngine.parseDetail` → `runPipeline`（与正式采集同一条管道）；
 * - Selector 校验走 `Parser.count`（与解析引擎同一适配器）；
 * - 页面快照复用统一请求层，SSRF / 超时 / 响应大小限制全部继承。
 */
import type { ProxyRow } from '../../database/index.js'
import { CrawlEngine, ParserError, cleanHtml, createParser } from '../../core/index.js'
import type { PluginRegistry } from '../../plugin-system/index.js'
import { createParserPluginRunner } from './task-executor.js'
import {
  createBrowserClient,
  RequestError,
  type BrowserClient,
  type RequestClient,
} from '../../request/index.js'
import {
  checkPagination,
  fieldRuleSchema,
  paginationSchema,
  parseRuleConfig,
} from '../../shared/index.js'
import type {
  CrawlContext,
  CrawlLogger,
  CrawlRequestOptions,
  CrawlRuleConfig,
  FieldRule,
  ListTestRequestBody,
  PageSnapshotDto,
  DetailTestRequestBody,
  ProxySettings,
  RuleValidationDto,
  SnapshotRequestBody,
  TesterDetailResultDto,
  TesterFieldResultDto,
  TesterListResultDto,
} from '../../shared/index.js'
import { z } from 'zod'
import { AppError, ValidationError } from '../errors.js'
import { assertProxyUsable, proxyToSettings } from './common.js'

/** 测试运行时依赖：统一请求客户端与 SSRF 策略。 */
export interface TesterRuntime {
  request: RequestClient
  /** 本地 fixture 测试时为 true；生产环境保持 false */
  allowPrivateNetwork: boolean
  /** 插件注册表：规则配置 parserPlugins 时，测试也走真实插件链 */
  pluginRegistry?: PluginRegistry
}

/** 默认测试超时，可通过请求体缩短，上限 60 秒。 */
export const TESTER_TIMEOUT_MS = 30_000
const TESTER_TIMEOUT_MAX_MS = 60_000

/** 页面快照 HTML 上限：超过后给明确错误，避免把巨型页面塞进响应。 */
const SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024

/** 快照正文截断上限（字符），预览不需要整个无限滚动页。 */
const SNAPSHOT_MAX_CHARS = 2_000_000

/** 列表测试最多返回的链接数。 */
const MAX_LIST_PREVIEW = 20

const silentLogger: CrawlLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/* -------------------------------------------------------------------------- */
/* 请求体 Schema                                                               */
/* -------------------------------------------------------------------------- */

const testerBaseSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, 'url 必填')
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), 'url 必须是 http(s) 绝对地址'),
    mode: z.enum(['http', 'browser']).optional(),
    /** 仅浏览器模式生效：等待到哪个生命周期事件（与 CrawlRequestOptions.waitUntil 对齐） */
    waitUntil: z.enum(['domcontentloaded', 'load', 'networkidle']).optional(),
    proxyId: z.number().int().positive().optional(),
    timeoutMs: z.number().int().min(1_000).max(TESTER_TIMEOUT_MAX_MS).optional(),
    headers: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
  })
  .strict()

export const snapshotBodySchema = testerBaseSchema

export const listTestBodySchema = testerBaseSchema.extend({
  list: z
    .object({
      itemSelector: z.string().trim().min(1, '列表项选择器必填').max(500),
      itemSelectorType: z.enum(['css', 'xpath']).optional(),
      /** 字段配置写法：title / url 必填，其余自定义（与保存的规则同构） */
      fields: z.record(z.string(), fieldRuleSchema).optional(),
      linkSelector: z.string().trim().max(500).optional(),
      linkAttribute: z.string().trim().max(64).optional(),
      titleSelector: z.string().trim().max(500).optional(),
      coverSelector: z.string().trim().max(500).optional(),
      coverAttribute: z.string().trim().max(64).optional(),
      /** 列表阶段的解析器插件链 */
      parserPlugins: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
      /** 列表阶段排除选择器：提取前先删除命中的节点 */
      excludeSelectors: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    })
    .strict(),
  pagination: paginationSchema.optional(),
})

export const detailTestBodySchema = testerBaseSchema.extend({
  fields: z.record(z.string(), fieldRuleSchema),
  /** 详情阶段排除选择器：提取前先删除命中的节点 */
  excludeSelectors: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  clean: z.object({ removeSelectors: z.array(z.string().max(500)).max(50).optional() }).strict().optional(),
  validate: z.object({ minContentLength: z.number().int().min(0).optional() }).strict().optional(),
  parserPlugins: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
})

export const ruleValidateBodySchema = z
  .object({ config: z.unknown() })
  .strict()

/* -------------------------------------------------------------------------- */
/* 内部工具                                                                    */
/* -------------------------------------------------------------------------- */

function resolveProxySetting(proxyId: number | undefined): ProxySettings | null {
  if (!proxyId) return null
  const row: ProxyRow = assertProxyUsable(proxyId)
  return proxyToSettings(row)
}

function resolveMode(input: { mode?: 'http' | 'browser' }): 'http' | 'browser' {
  return input.mode ?? 'http'
}

function describeError(error: unknown): string {
  if (error instanceof RequestError) return `${error.code}：${error.message}`
  if (error instanceof ParserError) return `${error.code}：${error.message}`
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `测试超时，请缩小超时时间或检查目标站点`
    }
    if (/Executable doesn't exist|browserType\.launch/.test(error.message)) {
      return '浏览器模式不可用：请先执行 npx playwright install chromium'
    }
    return error.message
  }
  return String(error)
}

interface TestContextInput {
  url: string
  mode?: 'http' | 'browser'
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'
  timeoutMs?: number
  headers?: Record<string, string>
}

/**
 * 为一次临时测试构造 CrawlContext。
 *
 * 站点/栏目快照使用占位值：测试器不落库，栏目 listUrl 直接指向测试地址，
 * 引擎与正式采集读到的是同样的结构。模式走 requestOptions，
 * 供 `engine.resolveMode` 与正式采集同一条判定路径。
 */
function buildTestContext(
  input: TestContextInput,
  config: CrawlRuleConfig,
  proxy: ProxySettings | null,
): CrawlContext {
  let origin = input.url
  try {
    origin = new URL(input.url).origin
  } catch {
    // URL 已在 Schema 层校验，这里只是兜底
  }

  const requestOptions: CrawlRequestOptions = {
    mode: input.mode ?? 'http',
    timeoutMs: input.timeoutMs ?? TESTER_TIMEOUT_MS,
    maxBytes: SNAPSHOT_MAX_BYTES,
    ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
  }

  return {
    site: { id: '0', name: '规则测试器', domain: '', baseUrl: origin },
    category: { id: '0', siteId: '0', name: '临时测试', code: null, listUrl: input.url, enabled: true },
    rule: { id: '0', version: 0, config },
    url: input.url,
    requestOptions,
    proxy,
    signal: AbortSignal.timeout(input.timeoutMs ?? TESTER_TIMEOUT_MS),
    logger: silentLogger,
    metadata: { tester: true },
  }
}

async function withBrowser<T>(
  mode: 'http' | 'browser',
  runtime: TesterRuntime,
  run: (engine: CrawlEngine) => Promise<T>,
): Promise<T> {
  let browser: BrowserClient | null = null
  if (mode === 'browser') {
    browser = createBrowserClient({
      ssrf: { allowPrivateNetwork: runtime.allowPrivateNetwork },
      timeoutMs: TESTER_TIMEOUT_MAX_MS,
    })
  }
  const engine = new CrawlEngine({
    request: runtime.request,
    browser,
    // 解析器插件链与正式采集同一实现（列表与详情阶段都执行）
    parserPluginRunner: runtime.pluginRegistry
      ? createParserPluginRunner(runtime.pluginRegistry)
      : undefined,
  })
  try {
    return await run(engine)
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

/* -------------------------------------------------------------------------- */
/* 页面快照                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 获取页面快照。
 *
 * HTML 经过 `cleanHtml` 清洗（去 script / 事件属性 / 危险协议 / iframe 等），
 * 再注入 `<base>` 保证相对资源可解析；前端必须放进 sandboxed iframe，
 * 绝不允许把原始 HTML v-html 进管理后台。
 */
export async function fetchPageSnapshot(
  input: SnapshotRequestBody,
  runtime: TesterRuntime,
): Promise<PageSnapshotDto> {
  const mode = resolveMode(input)
  const proxy = resolveProxySetting(input.proxyId)
  const context = buildTestContext(input, { version: 1 }, proxy)
  const startedAt = performance.now()

  try {
    const page = await withBrowser(mode, runtime, (engine) => engine.fetchPage(context))
    const title = extractTitle(page.html)
    const sanitized = buildSnapshotHtml(page.html, page.finalUrl)

    return {
      ok: true,
      url: input.url,
      finalUrl: page.finalUrl,
      statusCode: page.status,
      elapsedMs: page.elapsedMs,
      mode: page.mode,
      title,
      html: sanitized.length > SNAPSHOT_MAX_CHARS ? `${sanitized.slice(0, SNAPSHOT_MAX_CHARS)}\n<!-- 预览已截断 -->` : sanitized,
      base: page.finalUrl,
      message: `HTTP ${page.status}，${page.mode} 模式，耗时 ${page.elapsedMs} ms`,
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    return {
      ok: false,
      url: input.url,
      finalUrl: null,
      statusCode: null,
      elapsedMs: Math.round(performance.now() - startedAt),
      mode,
      title: null,
      html: '',
      base: null,
      message: describeError(error),
    }
  }
}

/** 提取 <title> 文本；失败不阻塞快照。 */
function extractTitle(html: string): string | null {
  try {
    return createParser().parseHtml(html).selectFirst('title')?.text().trim() || null
  } catch {
    return null
  }
}

/**
 * 清洗快照 HTML 并注入 `<base>`。
 *
 * - `cleanHtml` 移除 script / style / iframe / object / embed / form / link / meta、
 *   所有 on* 事件属性与 javascript: 等危险地址；
 * - 旧的 `<base>` 必须先移除，避免攻击者用它劫持相对地址解析；
 * - sandbox iframe 没有 allow-same-origin，注入脚本也无法读取管理后台数据。
 */
function buildSnapshotHtml(html: string, base: string): string {
  const cleaned = cleanHtml(html)
  const withoutBase = cleaned.replace(/<base\b[^>]*>/gi, '')
  const baseTag = `<base href="${base.replace(/"/g, '&quot;')}">`
  if (/<head[^>]*>/i.test(withoutBase)) {
    return withoutBase.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
  }
  if (/<html[^>]*>/i.test(withoutBase)) {
    return withoutBase.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`)
  }
  return `<head>${baseTag}</head>${withoutBase}`
}

/* -------------------------------------------------------------------------- */
/* 列表规则测试                                                                */
/* -------------------------------------------------------------------------- */

/** 用「未保存的列表规则」跑一次真实列表提取。 */
export async function testAdhocList(
  input: ListTestRequestBody,
  runtime: TesterRuntime,
): Promise<TesterListResultDto> {
  // 分页类型与参数在 Schema 层只校验结构，语义校验必须在这里补上：
  // next / cursor 未实现时要明确拒绝，不能静默只抓第一页。
  const paginationErrors = checkPagination(input.pagination)
  if (paginationErrors.length > 0) {
    throw new ValidationError(`分页配置不被支持：${paginationErrors.join('；')}`, paginationErrors.map((message) => ({
      path: 'pagination',
      message,
      code: 'invalid_value',
    })))
  }

  const mode = resolveMode(input)
  const config: CrawlRuleConfig = {
    version: 1,
    list: {
      itemSelector: input.list.itemSelector,
      ...(input.list.itemSelectorType ? { itemSelectorType: input.list.itemSelectorType } : {}),
      ...(input.list.fields ? { fields: input.list.fields as Record<string, FieldRule> } : {}),
      ...(input.list.linkSelector ? { linkSelector: input.list.linkSelector } : {}),
      ...(input.list.linkAttribute ? { linkAttribute: input.list.linkAttribute } : {}),
      ...(input.list.titleSelector ? { titleSelector: input.list.titleSelector } : {}),
      ...(input.list.coverSelector ? { coverSelector: input.list.coverSelector } : {}),
      ...(input.list.coverAttribute ? { coverAttribute: input.list.coverAttribute } : {}),
      ...(input.list.parserPlugins && input.list.parserPlugins.length > 0
        ? { parserPlugins: input.list.parserPlugins }
        : {}),
      ...(input.list.excludeSelectors && input.list.excludeSelectors.length > 0
        ? { excludeSelectors: input.list.excludeSelectors }
        : {}),
    },
    ...(input.pagination ? { pagination: input.pagination } : {}),
  }

  const proxy = resolveProxySetting(input.proxyId)
  const context = buildTestContext(input, config, proxy)
  const startedAt = performance.now()

  try {
    const page = await withBrowser(mode, runtime, (engine) => engine.listPage(context))
    const preview = page.links.slice(0, MAX_LIST_PREVIEW).map((link) => ({
      url: link.url,
      title: link.title ?? null,
      coverUrl: link.coverUrl ?? null,
      // 列表阶段的内置字段：让配置者一眼确认选择器是否命中
      author: link.author ?? null,
      summary: link.summary ?? null,
      articleTime: link.articleTime ?? null,
    }))

    return {
      ok: true,
      url: input.url,
      finalUrl: page.finalUrl,
      statusCode: page.status,
      elapsedMs: page.elapsedMs,
      mode: page.mode,
      itemCount: page.itemCount,
      linkCount: page.links.length,
      duplicateCount: page.duplicateCount,
      links: preview,
      message:
        page.itemCount === 0
          ? '列表项选择器没有命中任何节点，请检查 itemSelector'
          : `命中 ${page.itemCount} 个列表项，提取 ${page.links.length} 条唯一链接` +
            (page.duplicateCount > 0 ? `，丢弃 ${page.duplicateCount} 条重复/非法链接` : ''),
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    return {
      ok: false,
      url: input.url,
      finalUrl: null,
      statusCode: null,
      elapsedMs: Math.round(performance.now() - startedAt),
      mode,
      itemCount: 0,
      linkCount: 0,
      duplicateCount: 0,
      links: [],
      message: describeError(error),
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 详情规则测试                                                                */
/* -------------------------------------------------------------------------- */

/** 用「未保存的字段映射」跑一次真实详情解析（runPipeline 全链路）。 */
export async function testAdhocDetail(
  input: DetailTestRequestBody,
  runtime: TesterRuntime,
): Promise<TesterDetailResultDto> {
  if (Object.keys(input.fields).length === 0) {
    throw new ValidationError('至少配置一个字段才能测试详情规则', [
      { path: 'fields', message: '字段映射不能为空', code: 'invalid_value' },
    ])
  }

  const mode = resolveMode(input)
  const config: CrawlRuleConfig = {
    version: 1,
    fields: input.fields as Record<string, FieldRule>,
    ...(input.clean ? { clean: input.clean } : {}),
    ...(input.validate ? { validate: input.validate } : {}),
    ...(input.parserPlugins && input.parserPlugins.length > 0
      ? { parserPlugins: input.parserPlugins }
      : {}),
  }

  const proxy = resolveProxySetting(input.proxyId)
  const context = buildTestContext(input, config, proxy)
  const startedAt = performance.now()

  try {
    const result = await withBrowser(mode, runtime, (engine) =>
      engine.parseDetail(context, { url: input.url, sourceUrl: input.url }),
    )

    // 按用户配置的字段顺序输出诊断，而不是对象键序
    const fields: TesterFieldResultDto[] = Object.keys(input.fields).map((key) => {
      const extraction = result.fields[key]
      if (!extraction) {
        return { key, value: null, matched: 0, required: false, ok: false, error: '字段未被管道处理' }
      }
      return {
        key: extraction.key,
        value: extraction.value,
        matched: extraction.matched,
        required: extraction.required,
        ok: extraction.ok,
        ...(extraction.error ? { error: extraction.error } : {}),
      }
    })

    const missing = result.missing
    const ok = result.errors.length === 0 && missing.length === 0

    return {
      ok,
      url: input.url,
      finalUrl: result.article?.url ?? null,
      statusCode: null,
      elapsedMs: Math.round(performance.now() - startedAt),
      mode,
      fields,
      missing,
      errors: result.errors,
      article: result.article,
      message: ok
        ? `提取 ${fields.length} 个字段全部成功`
        : [
            missing.length > 0 ? `缺失必填字段：${missing.join('、')}` : null,
            result.errors.length > 0 ? result.errors.join('；') : null,
          ]
            .filter(Boolean)
            .join('；'),
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    return {
      ok: false,
      url: input.url,
      finalUrl: null,
      statusCode: null,
      elapsedMs: Math.round(performance.now() - startedAt),
      mode,
      fields: [],
      missing: [],
      errors: [describeError(error)],
      article: null,
      message: describeError(error),
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 规则 JSON 校验                                                              */
/* -------------------------------------------------------------------------- */

/** 用第三阶段 Rule Schema 校验规则 JSON，测试器不重复实现校验规则。 */
export function validateRuleInput(config: unknown): RuleValidationDto {
  const result = parseRuleConfig(config)
  return {
    valid: result.success,
    issues: result.success ? [] : result.issues,
  }
}
