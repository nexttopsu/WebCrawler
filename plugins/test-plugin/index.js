/**
 * 测试插件（test-plugin）。
 *
 * 用途：验证 WebCrawler 插件系统的完整链路——
 * 目录扫描登记（plugin.json）→ 启停管理 → SitePlugin 契约（match / getList / parseDetail）。
 *
 * 设计要点（与 PLUGINS.md 约定一致）：
 * - 只负责「匹配站点 → 提取列表链接 → 解析详情」，不碰数据库；
 * - HTTP 请求走注入的 services.request（统一代理 / 重试 / 编码 / SSRF / 取消）；
 * - HTML 解析走注入的 services.parser（CSS 选择器、URL 规范化、清洗），
 *   不自带任何解析或 HTTP 实现，也没有第三方依赖；
 * - 规则来自 context.rule.config（list / detail.fields / clean / validate），
 *   与通用站点插件（GenericSitePlugin）使用同一份规则结构。
 *
 * 注意：当前版本（0.6.x）服务端只登记清单、不动态加载本文件；
 * 本文件用于插件契约演示与 Vitest 直接验证（apps/server/test/plugin-system/test-plugin.test.ts）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 插件名，与 plugin.json 的 name 保持一致。 */
export const PLUGIN_NAME = 'test-plugin'

/** 插件错误码，与服务端 PluginErrorCode 对齐。 */
export const PluginErrorCode = {
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  NOT_MATCHED: 'NOT_MATCHED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
}

/** 插件错误：统一包装运行期异常，避免把底层错误直接抛给引擎。 */
export class PluginError extends Error {
  /**
   * @param {string} pluginName 出错的插件名
   * @param {string} code PluginErrorCode 之一
   * @param {string} message 错误信息
   * @param {unknown} [details] 附加诊断信息
   */
  constructor(pluginName, code, message, details) {
    super(message)
    this.name = 'PluginError'
    this.pluginName = pluginName
    this.code = code
    this.details = details
  }
}

/** 归一化域名：去掉协议、端口、路径与开头的 www.。 */
function normalizeDomain(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')
    .replace(/^www\./, '')
}

/** 明确不采集的链接协议。 */
const UNSAFE_LINK_PROTOCOL = /^(javascript|vbscript|file|mailto|tel|data):/i

/**
 * 读取同目录 plugin.json 的 config，作为默认插件配置。
 * 服务端动态加载（loadPluginInstance）时不会传参，配置以清单为准。
 */
function loadManifestConfig() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'))
    return manifest.config ?? {}
  } catch {
    return {}
  }
}

/** 测试插件：契约与 GenericSitePlugin 一致的独立实现。 */
export class TestPlugin {
  /**
   * @param {{ name?: string, version?: string, domains?: string[] }} [options]
   */
  constructor(options = {}) {
    const defaults = loadManifestConfig()
    this.name = options.name ?? defaults.name ?? PLUGIN_NAME
    this.version = options.version ?? defaults.version ?? '1.0.0'
    this.type = 'source'
    this.domains = (options.domains ?? defaults.domains ?? []).map(normalizeDomain).filter(Boolean)
    /** @type {{ request: object, parser: object, browser: object | null } | null} */
    this.services = null
  }

  /** 注入能力：只保存引用，不自行创建客户端。 */
  initialize(services) {
    this.services = services
  }

  /** 释放资源。 */
  destroy() {
    this.services = null
  }

  /** 域名匹配（含子域名）；未配置 domains 时匹配所有站点。 */
  match(url) {
    if (this.domains.length === 0) return true
    let hostname
    try {
      hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return false
    }
    return this.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  }

  /**
   * 列表页：按规则提取文章链接，过滤伪协议并按规范化 URL 去重。
   *
   * @param {object} context CrawlContext
   * @returns {Promise<Array<{ title?: string, url: string, sourceUrl: string }>>}
   */
  async getList(context) {
    const { parser } = this.requireServices()
    this.assertMatched(context.url)

    const list = context.rule?.config?.list ?? {}
    if (!list.itemSelector) {
      throw new PluginError(this.name, PluginErrorCode.EXECUTION_FAILED, '规则缺少 list.itemSelector，无法提取列表', {
        stage: 'list',
      })
    }

    const html = await this.fetchHtml(context, context.url)
    const doc = parser.parseHtml(html)
    const linkSelector = list.linkSelector ?? 'a'
    const seen = new Set()
    const links = []

    for (const node of doc.selectAll(list.itemSelector, 'css')) {
      const anchor = parser.selectWithin(node, linkSelector, 'css')[0]
      if (!anchor) continue
      const href = String(anchor.attr('href') ?? '').trim()
      if (!href || UNSAFE_LINK_PROTOCOL.test(href)) continue

      const absolute = parser.resolveUrl(href, context.url)
      const url = parser.normalizeUrl(absolute)
      if (!url || seen.has(url)) continue
      seen.add(url)

      const titleNode = list.titleSelector ? parser.selectWithin(node, list.titleSelector, 'css')[0] : anchor
      links.push({
        title: titleNode ? titleNode.text().trim() : undefined,
        url,
        sourceUrl: context.url,
      })
    }

    context.logger?.debug?.(`[${this.name}] 列表提取完成`, { count: links.length, url: context.url })
    return links
  }

  /**
   * 详情页：按规则提取字段、清洗正文并组装 ArticleData。
   *
   * @param {object} context CrawlContext
   * @param {{ url: string, sourceUrl?: string }} [link] 省略时使用 context.url
   * @returns {Promise<object>} ArticleData
   */
  async parseDetail(context, link) {
    const { parser } = this.requireServices()
    const target = link ?? { url: context.url, sourceUrl: context.url }
    this.assertMatched(target.url)

    const rule = context.rule?.config ?? {}
    const fields = rule.detail?.fields
    if (!fields) {
      throw new PluginError(this.name, PluginErrorCode.EXECUTION_FAILED, '规则缺少 detail.fields，无法解析详情', {
        stage: 'detail',
      })
    }

    const html = await this.fetchHtml(context, target.url)
    const extracted = parser.extractFields(html, fields, rule.validate ?? {})
    if (extracted.missing.length > 0) {
      throw new PluginError(
        this.name,
        PluginErrorCode.VALIDATION_FAILED,
        `必填字段缺失：${extracted.missing.join('、')}`,
        { missing: extracted.missing, fields: extracted.fields },
      )
    }

    const data = extracted.data
    const rawHtml =
      typeof data.html === 'string' ? data.html : typeof data.content === 'string' ? data.content : ''
    const cleanedHtml = rawHtml
      ? parser.cleanHtml(rawHtml, { removeSelectors: rule.clean?.removeSelectors ?? [] })
      : undefined

    const content = cleanedHtml
      ? parser.htmlToText(cleanedHtml)
      : typeof data.content === 'string'
        ? data.content
        : undefined
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : target.url
    // 文章时间：现行字段名是 articleTime，旧规则里可能写成 publishTime
    const articleTime =
      typeof data.articleTime === 'string' && data.articleTime
        ? data.articleTime
        : typeof data.publishTime === 'string' && data.publishTime
          ? data.publishTime
          : ''

    return {
      siteId: context.site?.id ?? '',
      categoryId: context.category?.id ?? '',
      title,
      url: target.url,
      ...(typeof data.author === 'string' && data.author ? { author: data.author } : {}),
      ...(articleTime ? { articleTime } : {}),
      ...(content ? { content } : {}),
      ...(typeof data.cover === 'string' && /^https?:\/\//i.test(data.cover) ? { coverUrl: data.cover } : {}),
      metadata: { sourceUrl: target.sourceUrl ?? context.url, plugin: this.name },
    }
  }

  /** @returns {NonNullable<TestPlugin['services']>} */
  requireServices() {
    if (!this.services) {
      throw new PluginError(this.name, PluginErrorCode.NOT_INITIALIZED, `插件 "${this.name}" 尚未初始化`)
    }
    return this.services
  }

  /** @param {string} url */
  assertMatched(url) {
    if (!this.match(url)) {
      throw new PluginError(this.name, PluginErrorCode.NOT_MATCHED, `插件 "${this.name}" 不负责该地址：${url}`)
    }
  }

  /** 统一请求：走注入的请求层，响应取消信号；非 2xx 抛 EXECUTION_FAILED。 */
  async fetchHtml(context, url) {
    const { request } = this.requireServices()
    let response
    try {
      response = await request.request({
        url,
        method: 'GET',
        signal: context.signal,
        timeoutMs: context.requestOptions?.timeoutMs ?? 15_000,
      })
    } catch (error) {
      throw new PluginError(
        this.name,
        PluginErrorCode.EXECUTION_FAILED,
        error instanceof Error ? error.message : String(error),
        { stage: 'request', url },
      )
    }
    if (!response.ok) {
      throw new PluginError(this.name, PluginErrorCode.EXECUTION_FAILED, `请求失败：HTTP ${response.status}`, {
        stage: 'request',
        url,
        status: response.status,
      })
    }
    return response.text
  }
}

/**
 * 默认导出插件实例：服务端 loadPluginInstance 动态加载入口文件时
 * 取 default 导出，要求 name / version / type / initialize 齐全且 name 与清单一致。
 */
export default new TestPlugin()
