/**
 * 通用站点插件。
 *
 * 绝大多数网站不需要写代码：只要规则里有 list / detail.fields，这个插件就能完成采集。
 * 它不做任何自己的解析，全部委托给 `CrawlEngine`，确保「插件采集」与「规则测试器」
 * 走的是同一条链路。
 */
import { CrawlEngine, type CrawlServices } from '@webcrawler/core'
import { PluginType, type ArticleData, type ArticleLink, type CrawlContext } from '@webcrawler/shared'
import { PluginError, PluginErrorCode, type SitePlugin } from './types.js'

/** 通用插件配置。 */
export interface GenericSitePluginOptions {
  /** 插件名，默认 generic-site */
  name?: string
  version?: string
  /** 负责的域名列表（含子域名）；为空表示匹配所有站点 */
  domains?: string[]
  description?: string
}

/** 归一化域名：去掉协议、端口与开头的 www. */
function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')
    .replace(/^www\./, '')
}

/** 由配置驱动的通用站点插件。 */
export class GenericSitePlugin implements SitePlugin {
  readonly name: string
  readonly version: string
  readonly type = PluginType.SOURCE
  readonly description: string
  private readonly domains: string[]
  private engine: CrawlEngine | null = null

  constructor(options: GenericSitePluginOptions = {}) {
    this.name = options.name ?? 'generic-site'
    this.version = options.version ?? '0.2.0'
    this.description = options.description ?? '配置驱动的通用站点采集插件'
    this.domains = (options.domains ?? []).map(normalizeDomain).filter(Boolean)
  }

  initialize(services: CrawlServices): void {
    this.engine = new CrawlEngine(services)
  }

  destroy(): void {
    this.engine = null
  }

  /** 域名匹配；未配置 domains 时匹配所有站点。 */
  match(url: string): boolean {
    if (this.domains.length === 0) return true

    let hostname: string
    try {
      hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return false
    }
    return this.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  }

  async getList(context: CrawlContext): Promise<ArticleLink[]> {
    const engine = this.requireEngine()
    this.assertMatched(context.url)

    try {
      return await engine.listLinks(context)
    } catch (error) {
      throw this.wrap(error, 'extract-list')
    }
  }

  async parseDetail(context: CrawlContext, link?: ArticleLink): Promise<ArticleData> {
    const engine = this.requireEngine()
    const target: ArticleLink = link ?? { url: context.url, sourceUrl: context.url }
    this.assertMatched(target.url)

    try {
      const result = await engine.parseDetail(context, target)
      if (!result.article) {
        throw new PluginError(
          this.name,
          PluginErrorCode.VALIDATION_FAILED,
          result.errors.join('；') || '数据校验未通过',
          { missing: result.missing, fields: result.fields },
        )
      }
      return result.article
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw this.wrap(error, 'extract-detail')
    }
  }

  private requireEngine(): CrawlEngine {
    if (!this.engine) {
      throw new PluginError(this.name, PluginErrorCode.NOT_INITIALIZED, `插件 "${this.name}" 尚未初始化`)
    }
    return this.engine
  }

  private assertMatched(url: string): void {
    if (!this.match(url)) {
      throw new PluginError(this.name, PluginErrorCode.NOT_MATCHED, `插件 "${this.name}" 不负责该地址：${url}`)
    }
  }

  /** 把核心层异常统一成插件错误，保留原始错误码便于排查。 */
  private wrap(error: unknown, stage: string): PluginError {
    const code =
      error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN'
    const message = error instanceof Error ? error.message : String(error)
    return new PluginError(this.name, PluginErrorCode.EXECUTION_FAILED, message, { stage, code }, { cause: error })
  }
}

/** 创建通用站点插件。 */
export function createGenericSitePlugin(options: GenericSitePluginOptions = {}): GenericSitePlugin {
  return new GenericSitePlugin(options)
}
