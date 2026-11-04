import type { CategoryRow, CrawlRuleRow, SiteRow } from '../../database/index.js'
import { CrawlEngine, ParserError } from '../../core/index.js'
import type { PluginRegistry } from '../../plugin-system/index.js'
import { createFlowPluginRunner, createParserPluginRunner } from './task-executor.js'
import {
  createBrowserClient,
  RequestError,
  type BrowserClient,
  type RequestClient,
} from '../../request/index.js'
import type { CategoryTestDto, CrawlContext, CrawlLogger, CrawlRequestOptions, CrawlRuleConfig, ProxySettings } from '../../shared/index.js'
import { AppError, ValidationError } from '../errors.js'
import {
  assertProxyUsable,
  findCategoryOrThrow,
  findRuleOrThrow,
  findSiteOrThrow,
  proxyToSettings,
  resolveBaseUrl,
} from './common.js'
import { resolveEffectiveRule } from './rule-service.js'

/** 测试运行时依赖：统一请求客户端与 SSRF 策略。 */
export interface TestRuntime {
  request: RequestClient
  /** 本地 fixture 测试时为 true；生产环境保持 false */
  allowPrivateNetwork: boolean
  /** 插件注册表：规则配置 parserPlugins 时，试抓也执行真实插件链 */
  pluginRegistry?: PluginRegistry
}

/** 测试接口最多返回的链接数，避免把整页链接塞进响应。 */
const MAX_PREVIEW_LINKS = 10

/** 单次测试的总超时：列表页只抓一次，30 秒足够。 */
const TEST_TIMEOUT_MS = 30_000

const silentLogger: CrawlLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * 决定测试使用的代理。
 *
 * 优先级与正式采集一致：规则 `request.proxy`（`null` 表示显式直连）
 * > 栏目代理 > 站点默认代理。
 */
function resolveProxy(
  site: SiteRow,
  category: CategoryRow | null,
  config: CrawlRuleConfig,
): ProxySettings | null {
  if (config.request?.proxy !== undefined) return config.request.proxy

  const proxyId = category?.proxyId ?? site.defaultProxyId
  if (!proxyId) return null

  return proxyToSettings(assertProxyUsable(proxyId))
}

interface ListTestTarget {
  site: SiteRow
  category: CategoryRow | null
  rule: { id: number; name: string; version: number; config: CrawlRuleConfig }
  /** 实际抓取的列表页地址 */
  listUrl: string
}

/**
 * 列表规则测试的核心实现。
 *
 * 与正式采集共用 `CrawlEngine.listPage`：同一套请求层、解析器与链接提取逻辑，
 * 因此测试结果与任务执行结果一致。第四阶段的可视化测试器直接复用本函数。
 */
async function runListTest(target: ListTestTarget, runtime: TestRuntime): Promise<CategoryTestDto> {
  const { config } = target.rule
  if (!config.list?.itemSelector) {
    throw new ValidationError('规则缺少 list.itemSelector，无法测试列表页', [
      { path: 'config.list.itemSelector', message: '必须提供列表项选择器', code: 'invalid_value' },
    ])
  }

  const mode = config.request?.mode ?? (config.browser?.enabled ? 'browser' : 'http')
  const proxy = resolveProxy(target.site, target.category, config)
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS)

  const requestOptions: CrawlRequestOptions = {}

  const context: CrawlContext = {
    site: {
      id: String(target.site.id),
      name: target.site.name ?? '',
      domain: target.site.domain ?? '',
      baseUrl: target.site.baseUrl ?? resolveBaseUrl(undefined, target.site.domain ?? ''),
      pluginName: target.site.pluginName,
      status: target.site.status ?? 'active',
    },
    category: {
      id: String(target.category?.id ?? 0),
      siteId: String(target.site.id),
      name: target.category?.name ?? target.rule.name,
      code: target.category?.code ?? null,
      listUrl: target.listUrl,
      enabled: true,
    },
    rule: {
      id: String(target.rule.id),
      version: target.rule.version,
      config,
    },
    url: target.listUrl,
    requestOptions,
    proxy,
    signal,
    logger: silentLogger,
    metadata: { test: true },
  }

  let browser: BrowserClient | null = null
  if (mode === 'browser') {
    browser = createBrowserClient({
      ssrf: { allowPrivateNetwork: runtime.allowPrivateNetwork },
      timeoutMs: config.browser?.timeoutMs ?? TEST_TIMEOUT_MS,
    })
  }

  const engine = new CrawlEngine({
    request: runtime.request,
    browser,
    parserPluginRunner: runtime.pluginRegistry
      ? createParserPluginRunner(runtime.pluginRegistry, runtime.request)
      : undefined,
    flowPluginRunner: runtime.pluginRegistry
      ? createFlowPluginRunner(runtime.pluginRegistry, runtime.request)
      : undefined,
  })
  const startedAt = performance.now()

  try {
    const page = await engine.listPage(context)
    const preview = page.links.slice(0, MAX_PREVIEW_LINKS).map((link) => ({
      url: link.url,
      title: link.title ?? null,
      coverUrl: link.coverUrl ?? null,
    }))

    return {
      ok: true,
      url: target.listUrl,
      finalUrl: page.finalUrl,
      statusCode: page.status,
      elapsedMs: page.elapsedMs,
      mode: page.mode,
      itemCount: page.itemCount,
      linkCount: page.links.length,
      links: preview,
      message:
        page.itemCount === 0
          ? '列表项选择器没有命中任何节点，请检查 itemSelector'
          : `命中 ${page.itemCount} 个列表项，提取 ${page.links.length} 条链接`,
    }
  } catch (error) {
    if (error instanceof AppError) throw error

    const message = describeTestError(error, mode)
    return {
      ok: false,
      url: target.listUrl,
      finalUrl: null,
      statusCode: null,
      elapsedMs: Math.round(performance.now() - startedAt),
      mode,
      itemCount: 0,
      linkCount: 0,
      links: [],
      message,
    }
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

function describeTestError(error: unknown, mode: 'http' | 'browser'): string {
  if (error instanceof RequestError) return `${error.code}：${error.message}`
  if (error instanceof ParserError) return `${error.code}：${error.message}`
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `测试超时（${TEST_TIMEOUT_MS} ms）`
    }
    if (mode === 'browser' && /Executable doesn't exist|browserType.launch/.test(error.message)) {
      return '浏览器模式不可用：请先执行 npx playwright install chromium'
    }
    return error.message
  }
  return String(error)
}

/**
 * 栏目级测试：使用「站点默认规则 + 栏目规则」合并后的生效规则，
 * 抓取栏目列表页并返回命中数量与链接预览。
 */
export async function testCategoryListing(
  categoryId: number,
  runtime: TestRuntime,
): Promise<CategoryTestDto> {
  const category = findCategoryOrThrow(categoryId)
  const site = findSiteOrThrow(category.siteId ?? 0)
  const effective = resolveEffectiveRule({ siteId: site.id, categoryId: category.id })

  if (!effective.config) {
    throw new ValidationError('栏目尚未关联采集规则，无法测试', [
      { path: 'ruleId', message: '请先为栏目关联规则', code: 'invalid_value' },
    ])
  }

  const rule = category.ruleId ? findRuleOrThrow(category.ruleId) : null
  const listUrl = effective.config.list?.url ?? category.listUrl ?? site.baseUrl ?? ''

  return runListTest(
    {
      site,
      category,
      rule: {
        id: rule?.id ?? 0,
        name: rule?.name ?? '站点默认规则',
        version: rule?.version ?? 0,
        config: effective.config,
      },
      listUrl,
    },
    runtime,
  )
}

/**
 * 规则级测试：直接用规则自身（必要时叠加站点默认规则）抓取列表页。
 *
 * `overrideUrl` 允许在不保存规则的前提下试抓另一个列表地址，
 * 第四阶段的规则编辑器需要这个能力。
 */
export async function testRuleListing(
  ruleId: number,
  runtime: TestRuntime,
  overrideUrl?: string,
): Promise<CategoryTestDto> {
  const ruleRow: CrawlRuleRow = findRuleOrThrow(ruleId)
  const site = findSiteOrThrow(ruleRow.siteId ?? 0)
  const effective = resolveEffectiveRule({
    siteId: site.id,
    ...(ruleRow.categoryId ? { categoryId: ruleRow.categoryId } : {}),
  })

  if (!effective.config) {
    throw new ValidationError('规则配置为空，无法测试', [
      { path: 'config', message: '规则缺少配置', code: 'invalid_value' },
    ])
  }

  const listUrl =
    overrideUrl?.trim() ||
    effective.config.list?.url ||
    (ruleRow.categoryId
      ? (findCategoryOrThrow(ruleRow.categoryId).listUrl ?? '')
      : '') ||
    site.baseUrl ||
    ''

  if (!/^https?:\/\//i.test(listUrl)) {
    throw new ValidationError('缺少可测试的列表页地址：请在规则中配置 list.url', [
      { path: 'config.list.url', message: '必须提供列表页地址', code: 'invalid_value' },
    ])
  }

  let config: CrawlRuleConfig = effective.config
  if (overrideUrl?.trim()) {
    config = { ...config, list: { ...(config.list ?? { itemSelector: '' }), url: overrideUrl.trim() } }
  }

  return runListTest(
    {
      site,
      category: ruleRow.categoryId ? findCategoryOrThrow(ruleRow.categoryId) : null,
      rule: { id: ruleRow.id, name: ruleRow.name ?? '', version: ruleRow.version ?? 1, config },
      listUrl,
    },
    runtime,
  )
}
