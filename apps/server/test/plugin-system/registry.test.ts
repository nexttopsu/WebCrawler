import { describe, expect, it } from 'vitest'
import {
  PluginRegistryError,
  createPluginRegistry,
  describePlugin,
  pluginSlots,
  type PluginModule,
  type RegisteredPlugin,
} from '../../src/plugin-system/index.js'

/** 全流程插件桩：按需给出 getList / getDetail。 */
function flowPlugin(id: string, functions: { list?: boolean; detail?: boolean } = {}): RegisteredPlugin {
  return {
    config: { id, name: id, type: 'flow' },
    source: `src/plugins/${id}.ts`,
    ...(functions.list === false ? {} : { getList: async () => [], }),
    ...(functions.detail === false ? {} : { getDetail: async () => ({ title: id }) }),
  }
}

/** 解析器插件桩。 */
function parserPlugin(id: string, functions: { list?: boolean; detail?: boolean } = {}): RegisteredPlugin {
  return {
    config: { id, name: id, type: 'parser' },
    source: `src/plugins/${id}.ts`,
    ...(functions.list === false ? {} : { parseList: async (_url, fields) => fields }),
    ...(functions.detail === false ? {} : { parseDetail: async (_url, fields) => fields }),
  }
}

describe('插件能力推导', () => {
  it('全流程插件按导出的函数推导阶段', () => {
    expect(pluginSlots(flowPlugin('both'))).toEqual(['list', 'detail'])
    expect(pluginSlots(flowPlugin('list-only', { detail: false }))).toEqual(['list'])
    expect(pluginSlots(flowPlugin('detail-only', { list: false }))).toEqual(['detail'])
  })

  it('解析器插件按导出的函数推导阶段', () => {
    expect(pluginSlots(parserPlugin('both'))).toEqual(['list', 'detail'])
    expect(pluginSlots(parserPlugin('list-only', { detail: false }))).toEqual(['list'])
    expect(pluginSlots(parserPlugin('detail-only', { list: false }))).toEqual(['detail'])
  })

  it('描述文案区分类型与阶段', () => {
    expect(describePlugin(flowPlugin('a'))).toBe('列表 + 详情插件')
    expect(describePlugin(flowPlugin('b', { detail: false }))).toBe('列表插件')
    expect(describePlugin(flowPlugin('c', { list: false }))).toBe('详情插件')
    expect(describePlugin(parserPlugin('d'))).toBe('解析器（列表 + 详情）')
    expect(describePlugin(parserPlugin('e', { list: false }))).toBe('解析器（详情）')
    // 一个函数都没导出的插件也会被描述成「未实现函数」，便于错误提示
    const empty: PluginModule = { config: { id: 'empty', name: 'empty', type: 'flow' } }
    expect(describePlugin(empty)).toBe('未实现函数插件')
    expect(pluginSlots(empty)).toEqual([])
  })
})

describe('插件注册表', () => {
  it('按 id 注册、查询、注销', () => {
    const registry = createPluginRegistry()
    registry.register(flowPlugin('b-plugin'))
    registry.register(parserPlugin('a-plugin'))

    expect(registry.size).toBe(2)
    expect(registry.list().map((item) => item.config.id)).toEqual(['a-plugin', 'b-plugin'])
    expect(registry.get('a-plugin')?.config.type).toBe('parser')

    expect(registry.unregister('a-plugin')).toBe(true)
    expect(registry.unregister('a-plugin')).toBe(false)
    expect(registry.size).toBe(1)
  })

  it('重复注册同 id 报错，replace 允许覆盖（扫描刷新用）', () => {
    const registry = createPluginRegistry()
    registry.register(flowPlugin('dup'))

    expect(() => registry.register(flowPlugin('dup'))).toThrow(PluginRegistryError)
    registry.replace(flowPlugin('dup', { detail: false }))
    expect(pluginSlots(registry.get('dup')!)).toEqual(['list'])
  })

  it('拒绝空 id', () => {
    const registry = createPluginRegistry()
    expect(() =>
      registry.register({ config: { id: '  ', name: 'x', type: 'flow' }, source: 'src/plugins/x.ts' }),
    ).toThrow(PluginRegistryError)
  })

  it('getFlow 只返回全流程插件，且阶段能力必须匹配', () => {
    const registry = createPluginRegistry()
    registry.register(flowPlugin('flow-both'))
    registry.register(flowPlugin('flow-list', { detail: false }))
    registry.register(parserPlugin('parser-both'))

    expect(registry.getFlow('flow-both', 'list')?.config.id).toBe('flow-both')
    expect(registry.getFlow('flow-both', 'detail')?.config.id).toBe('flow-both')
    // 只实现列表的插件不能挂详情
    expect(registry.getFlow('flow-list', 'detail')).toBeUndefined()
    // 解析器插件不是全流程插件
    expect(registry.getFlow('parser-both', 'list')).toBeUndefined()
    expect(registry.getFlow('missing', 'list')).toBeUndefined()
  })

  it('getParser 只返回解析器插件，且阶段能力必须匹配', () => {
    const registry = createPluginRegistry()
    registry.register(parserPlugin('parser-both'))
    registry.register(parserPlugin('parser-detail', { list: false }))
    registry.register(flowPlugin('flow-both'))

    expect(registry.getParser('parser-both', 'list')?.config.id).toBe('parser-both')
    expect(registry.getParser('parser-detail', 'list')).toBeUndefined()
    expect(registry.getParser('parser-detail', 'detail')?.config.id).toBe('parser-detail')
    expect(registry.getParser('flow-both', 'detail')).toBeUndefined()
  })

  it('clear 清空注册表', () => {
    const registry = createPluginRegistry()
    registry.register(flowPlugin('a'))
    registry.register(flowPlugin('b'))
    registry.clear()
    expect(registry.size).toBe(0)
    expect(registry.list()).toEqual([])
  })
})
