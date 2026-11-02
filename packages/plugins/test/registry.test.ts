import { describe, expect, it } from 'vitest'
import { PluginType } from '@webcrawler/shared'
import { PluginRegistryError, createPluginRegistry } from '../src/index.js'

describe('插件注册表', () => {
  it('注册、查询、注销插件', () => {
    const registry = createPluginRegistry()
    registry.register({ name: 'b-plugin', version: '1.0.0', type: PluginType.PARSER })
    registry.register({ name: 'a-plugin', version: '1.0.0', type: PluginType.SOURCE })

    expect(registry.size).toBe(2)
    expect(registry.list().map((item) => item.name)).toEqual(['a-plugin', 'b-plugin'])
    expect(registry.get('a-plugin')?.type).toBe(PluginType.SOURCE)

    expect(registry.unregister('a-plugin')).toBe(true)
    expect(registry.unregister('a-plugin')).toBe(false)
    expect(registry.size).toBe(1)
  })

  it('重复注册同名插件时报错', () => {
    const registry = createPluginRegistry()
    registry.register({ name: 'dup', version: '1.0.0', type: PluginType.EXPORTER })

    expect(() => registry.register({ name: 'dup', version: '2.0.0', type: PluginType.EXPORTER })).toThrow(
      PluginRegistryError,
    )
  })

  it('拒绝空名称', () => {
    const registry = createPluginRegistry()
    expect(() => registry.register({ name: '  ', version: '1.0.0', type: PluginType.HOOK })).toThrow(
      PluginRegistryError,
    )
  })
})
