import {
  PluginRegistryError,
  type PluginSlot,
  type RegisteredPlugin,
} from './types.js'

/**
 * 内存中的插件注册表。
 *
 * 插件全部内置：进程启动时由 `registerBuiltinPlugins` 一次性写入，
 * 运行期间只会有启停带来的增删，不会重新读取文件。
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>()

  /** 注册插件；同 id 已存在时抛错，避免静默覆盖。 */
  register(plugin: RegisteredPlugin): void {
    const id = plugin.config.id.trim()
    if (!id) throw new PluginRegistryError('插件 id 不能为空')
    if (this.plugins.has(id)) throw new PluginRegistryError(`插件 "${id}" 已注册`)
    this.plugins.set(id, { ...plugin, config: { ...plugin.config, id } })
  }

  /** 覆盖同 id 插件（测试或替换实现时用）。 */
  replace(plugin: RegisteredPlugin): void {
    const id = plugin.config.id.trim()
    if (!id) throw new PluginRegistryError('插件 id 不能为空')
    this.plugins.set(id, { ...plugin, config: { ...plugin.config, id } })
  }

  /** 按 id 注销，返回是否确实移除了记录。 */
  unregister(id: string): boolean {
    return this.plugins.delete(id)
  }

  /** 按 id 取插件。 */
  get(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id)
  }

  /** 全部插件，按 id 排序，保证输出稳定。 */
  list(): RegisteredPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.config.id.localeCompare(b.config.id))
  }

  /** 取解析器插件；阶段不符（没导出对应函数）时返回 undefined。 */
  getParser(id: string, slot: PluginSlot): RegisteredPlugin | undefined {
    const plugin = this.plugins.get(id)
    if (!plugin || plugin.config.type !== 'parser') return undefined
    return slot === 'list' ? (plugin.parseList ? plugin : undefined) : plugin.parseDetail ? plugin : undefined
  }

  /**
   * 取全流程插件。
   *
   * `slot` 用来校验能力：插件没导出 `getList` 就不能挂列表，
   * 没导出 `getDetail` 就不能挂详情。返回 undefined 时调用方给出明确错误。
   */
  getFlow(id: string, slot: PluginSlot): RegisteredPlugin | undefined {
    const plugin = this.plugins.get(id)
    if (!plugin || plugin.config.type !== 'flow') return undefined
    return slot === 'list' ? (plugin.getList ? plugin : undefined) : plugin.getDetail ? plugin : undefined
  }

  /** 清空注册表（进程重启或测试复位时用）。 */
  clear(): void {
    this.plugins.clear()
  }

  /** 已登记数量。 */
  get size(): number {
    return this.plugins.size
  }
}

/** 创建插件注册表。 */
export function createPluginRegistry(): PluginRegistry {
  return new PluginRegistry()
}

export const PLUGINS_PACKAGE = {
  name: 'plugin-system',
  version: '0.7.0',
  description: '插件系统：内置插件契约、类型 SDK 与注册表',
} as const

export * from './types.js'
export { definePlugin, validatePluginModule } from './sdk.js'
export type {
  FlowDetailOnlyModule,
  FlowListOnlyModule,
  FlowPluginConfig,
  FlowPluginModule,
  ParserDetailOnlyModule,
  ParserListOnlyModule,
  ParserPluginConfig,
  ParserPluginModule,
  PluginRuntime,
} from './sdk.js'
