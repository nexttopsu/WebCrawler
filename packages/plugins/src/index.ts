import type { CrawlServices } from '@webcrawler/core'
import {
  PluginRegistryError,
  isSitePlugin,
  type CrawlerPlugin,
  type PluginManifest,
  type SitePlugin,
} from './types.js'

/**
 * 内存中的插件注册表。
 *
 * 管理两类信息：
 * - 清单（manifest）：用于展示与落库；
 * - 运行时实例（plugin）：用于真正执行采集。
 *
 * 注册表不负责加载代码，也不碰数据库；加载器与持久化在后续阶段接入。
 */
export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>()
  private readonly instances = new Map<string, CrawlerPlugin>()

  /** 注册插件清单；同名已存在时抛错，避免静默覆盖。 */
  register(manifest: PluginManifest): void {
    const name = manifest.name.trim()
    if (!name) {
      throw new PluginRegistryError('插件名不能为空')
    }
    if (this.manifests.has(name)) {
      throw new PluginRegistryError(`插件 "${name}" 已注册`)
    }
    this.manifests.set(name, { ...manifest, name })
  }

  /** 注销清单，返回是否确实移除了记录。 */
  unregister(name: string): boolean {
    return this.manifests.delete(name)
  }

  /** 按名称取清单。 */
  get(name: string): PluginManifest | undefined {
    return this.manifests.get(name)
  }

  /** 全部清单，按名称排序，保证输出稳定。 */
  list(): PluginManifest[] {
    return [...this.manifests.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 已登记数量。 */
  get size(): number {
    return this.manifests.size
  }

  /** 注册运行时实例，同时补齐清单。 */
  registerPlugin(plugin: CrawlerPlugin): void {
    const name = plugin.name.trim()
    if (!name) throw new PluginRegistryError('插件名不能为空')
    if (this.instances.has(name)) throw new PluginRegistryError(`插件实例 "${name}" 已注册`)

    this.instances.set(name, plugin)
    if (!this.manifests.has(name)) {
      this.manifests.set(name, {
        name,
        version: plugin.version,
        type: plugin.type,
        ...(isSitePlugin(plugin) ? { description: '站点插件' } : {}),
      })
    }
  }

  /** 注销运行时实例。 */
  unregisterPlugin(name: string): boolean {
    return this.instances.delete(name)
  }

  /** 按名称取运行时实例。 */
  getPlugin(name: string): CrawlerPlugin | undefined {
    return this.instances.get(name)
  }

  /** 取站点插件；不是站点插件时返回 undefined。 */
  getSitePlugin(name: string): SitePlugin | undefined {
    const plugin = this.instances.get(name)
    return plugin && isSitePlugin(plugin) ? plugin : undefined
  }

  /** 全部运行时实例，按名称排序。 */
  listPlugins(): CrawlerPlugin[] {
    return [...this.instances.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 按 URL 找出第一个负责它的站点插件。 */
  findSitePlugin(url: string): SitePlugin | undefined {
    return this.listPlugins().filter(isSitePlugin).find((plugin) => plugin.match(url))
  }

  /** 依次初始化插件；单个失败不影响其它插件，返回失败列表。 */
  async initializeAll(services: CrawlServices): Promise<{ name: string; error: Error }[]> {
    const failures: { name: string; error: Error }[] = []
    for (const plugin of this.listPlugins()) {
      try {
        await plugin.initialize(services)
      } catch (error) {
        failures.push({ name: plugin.name, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    return failures
  }

  /** 依次释放插件；逐个隔离异常。 */
  async destroyAll(): Promise<void> {
    for (const plugin of this.listPlugins()) {
      try {
        await plugin.destroy()
      } catch {
        // 销毁失败不影响其它插件释放
      }
    }
  }
}

/** 创建插件注册表。 */
export function createPluginRegistry(): PluginRegistry {
  return new PluginRegistry()
}

export const PLUGINS_PACKAGE = {
  name: '@webcrawler/plugins',
  version: '0.6.0',
  description: '插件系统：契约、注册表与通用站点插件',
} as const

export * from './types.js'
export * from './generic-site-plugin.js'
