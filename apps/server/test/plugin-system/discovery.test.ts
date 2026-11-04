/**
 * 内置插件自动发现。
 *
 * 插件的唯一「登记方式」是文件本身：放进 `src/plugins/`（可以再套目录），
 * 用 `export default definePlugin(...)` 导出即可，不用改 `index.ts`。
 *
 * 这里验证三件事：
 *   1. 目录遍历规则（递归、跳过私有文件与非目标扩展名、顺序稳定）；
 *   2. 单个文件出问题只影响它自己，错误信息能说清原因；
 *   3. 仓库里的插件确实是被自动扫出来的，`source` 指得回源码。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { builtinPluginFailures, builtinPlugins, collectPluginFiles, importPluginFile } from '../../src/plugins/index.js'

/** 造一棵混合目录树，返回根目录。 */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'wc-plugins-'))
  const dirs = ['news', join('news', 'deep'), '_draft', 'node_modules', 'assets']
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })

  const files = [
    'a.ts',
    join('news', 'b.ts'),
    join('news', 'deep', 'c.ts'),
    join('news', 'index.ts'),
    '_helper.ts',
    join('_draft', 'd.ts'),
    '.hidden.ts',
    'types.d.ts',
    'readme.md',
    join('node_modules', 'e.ts'),
    join('assets', 'cover.png'),
  ]
  for (const file of files) writeFileSync(join(root, file), '')

  return root
}

/** 把绝对路径裁成相对根目录的形式，方便断言。 */
function relativeTo(root: string, files: string[]): string[] {
  return files.map((file) => file.slice(root.length + 1).split('\\').join('/'))
}

describe('插件文件发现', () => {
  it('递归子目录，按路径排序', () => {
    const root = makeTree()
    expect(relativeTo(root, collectPluginFiles(root, '.ts'))).toEqual([
      'a.ts',
      'news/b.ts',
      'news/deep/c.ts',
      'news/index.ts',
    ])
  })

  it('跳过 `_` / `.` 开头的文件与目录、声明文件、非目标扩展名、node_modules', () => {
    const root = makeTree()
    const files = relativeTo(root, collectPluginFiles(root, '.ts'))

    expect(files).not.toContain('_helper.ts')
    expect(files).not.toContain('_draft/d.ts')
    expect(files).not.toContain('.hidden.ts')
    expect(files).not.toContain('types.d.ts')
    expect(files).not.toContain('readme.md')
    expect(files).not.toContain('node_modules/e.ts')
    expect(files).not.toContain('assets/cover.png')
  })

  it('扩展名跟随调用方：生产构建后扫 `.js`', () => {
    const root = makeTree()
    writeFileSync(join(root, 'compiled.js'), '')

    expect(relativeTo(root, collectPluginFiles(root, '.js'))).toEqual(['compiled.js'])
  })
})

describe('单个插件文件的加载', () => {
  /** 写一个临时插件文件并返回路径。 */
  function writePlugin(body: string): string {
    const root = mkdtempSync(join(tmpdir(), 'wc-plugin-'))
    const file = join(root, 'plugin.mjs')
    writeFileSync(file, body, 'utf8')
    return file
  }

  it('取 `export default` 并放行合法插件', async () => {
    const file = writePlugin(`
      export default {
        config: { id: 'tmp-flow', name: '临时插件', type: 'flow' },
        async getList() { return [] },
      }
    `)

    const plugin = await importPluginFile(file)
    expect(plugin.config.id).toBe('tmp-flow')
    expect(typeof plugin.getList).toBe('function')
  })

  it('也接受 `export const plugin`', async () => {
    const file = writePlugin(`
      export const plugin = {
        config: { id: 'tmp-parser', name: '临时解析器', type: 'parser' },
        async parseDetail(_url, fields) { return fields },
      }
    `)

    expect((await importPluginFile(file)).config.id).toBe('tmp-parser')
  })

  it('没有导出插件对象时报出约定写法', async () => {
    const file = writePlugin(`export const helper = 1`)
    await expect(importPluginFile(file)).rejects.toThrow('export default definePlugin')
  })

  it('类型与实现的函数不匹配时报出原因', async () => {
    const file = writePlugin(`
      export default {
        config: { id: 'wrong', name: '写错类型', type: 'parser' },
        async getList() { return [] },
      }
    `)
    await expect(importPluginFile(file)).rejects.toThrow('parseList')
  })

  it('文件本身语法错误时抛错，而不是静默跳过', async () => {
    const file = writePlugin(`export default {`)
    await expect(importPluginFile(file)).rejects.toThrow()
  })
})

describe('仓库内置插件', () => {
  it('无需登记就被扫到，且平铺与嵌套目录都在', () => {
    const byId = new Map(builtinPlugins.map((entry) => [entry.plugin.config.id, entry]))

    expect(byId.get('demo-fixture')?.source).toBe('src/plugins/demo-fixture.ts')
    // 这两个放在 examples/ 子目录里，验证嵌套目录同样被发现
    expect(byId.get('example-flow-news')?.source).toBe('src/plugins/examples/example-flow-news.ts')
    expect(byId.get('example-parser-clean')?.source).toBe('src/plugins/examples/example-parser-clean.ts')
    expect(builtinPluginFailures).toEqual([])
  })

  it('清单入口自己不会被当成插件', () => {
    const sources = builtinPlugins.map((entry) => entry.source)
    expect(sources).not.toContain('src/plugins/index.ts')
  })

  it('source 都能在源码目录里找到对应文件', () => {
    // 本文件位于 apps/server/test/plugin-system/，往上两级就是服务端根目录
    const serverRoot = fileURLToPath(new URL('../..', import.meta.url))
    for (const entry of builtinPlugins) {
      expect(existsSync(join(serverRoot, entry.source)), `${entry.source} 不存在`).toBe(true)
    }
  })
})
