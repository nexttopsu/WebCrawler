/**
 * 内置插件自动发现。
 *
 * 插件只有这一种存在方式：写在 `src/plugins/` 下，用 `definePlugin` 定义并 `export default`，
 * 随服务端一起编译。**不需要在这里登记**——本文件在模块加载时递归扫描同目录，
 * 把所有插件 import 进来，`builtinPlugins` 拿到的就是完整清单。
 *
 * 扫描规则（约定优于配置）：
 *   - 递归子目录，所以可以按站点/业务分目录存放；
 *   - 只收与当前文件同扩展名的模块（开发期 `.ts`，构建后 `.js`）；
 *   - 跳过 `index.*`（本文件）、`*.d.ts`、`node_modules`；
 *   - 跳过 `.` 与 `_` 开头的文件与目录——留给作者的私有物（工具函数、草稿、备份）。
 *
 * 加载时机：模块只求值一次（顶层 await），所以「进程启动时加载一次」是天然成立的，
 * 运行期不会重复读文件。改插件代码需要重启服务。
 *
 * 某个文件 import 失败或没有导出合法插件，不影响其它插件：失败项收进
 * `builtinPluginFailures`，由 `registerBuiltinPlugins()` 统一写日志。
 */
import { readdirSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validatePluginModule, type PluginModule } from '../plugin-system/index.js'

/** 一条内置插件登记：插件本体 + 它来自哪个文件。 */
export interface BuiltinPluginEntry {
  /** 相对源码目录的路径（`src/plugins/...`），出现在错误日志与插件详情里 */
  source: string
  plugin: PluginModule
}

/** 一个没能加载的文件。 */
export interface BuiltinPluginFailure {
  file: string
  error: string
}

const SELF = fileURLToPath(import.meta.url)
const ROOT = dirname(SELF)
/** 与当前文件一致：开发期由 tsx 直接跑 `.ts`，构建后是 `.js` */
const EXT = extname(SELF)

/**
 * 收集插件文件。
 *
 * 用同步 API 是因为它只在模块初始化时跑一次，几十个文件的遍历成本可以忽略，
 * 而异步遍历会让「加载顺序不稳定」这种问题变得难查。
 *
 * 参数可注入只为测试：默认扫本文件所在目录，扩展名跟随本文件。
 */
export function collectPluginFiles(root: string = ROOT, ext: string = EXT): string[] {
  const files: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const { name } = entry
      if (name.startsWith('.') || name.startsWith('_')) continue

      if (entry.isDirectory()) {
        if (name === 'node_modules') continue
        walk(join(dir, name))
        continue
      }

      if (!entry.isFile()) continue
      if (extname(name) !== ext || name.endsWith('.d.ts')) continue

      const full = join(dir, name)
      // 只排除「本文件」这一份汇总入口；子目录里的 index.ts 照样可以是插件
      if (full === SELF) continue
      files.push(full)
    }
  }

  walk(root)
  // 固定顺序：注册表、日志、界面列表的先后不随文件系统变化
  return files.sort()
}

/** 展示用路径：构建后也能指回源码，统一写成 `.ts`。 */
function toSource(file: string): string {
  const path = relative(ROOT, file).split(sep).join('/')
  return `src/plugins/${path.replace(/\.(js|mjs|cjs)$/, '.ts')}`
}

/** import 一个文件并取出它导出的插件；不合格就抛错（由调用方收集）。 */
export async function importPluginFile(file: string): Promise<PluginModule> {
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  // 约定 `export default definePlugin({...})`；也接受 `export const plugin = ...`
  const candidate = 'default' in module ? module.default : module.plugin

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('没有导出插件对象，请用 `export default definePlugin({ ... })`')
  }

  const problem = validatePluginModule(candidate as PluginModule)
  if (problem) throw new Error(problem)
  return candidate as PluginModule
}

const entries: BuiltinPluginEntry[] = []
const failures: BuiltinPluginFailure[] = []
/** id → 来源文件，用于发现重复定义（比如构建残留让新旧两份同时存在） */
const seen = new Map<string, string>()

for (const file of collectPluginFiles()) {
  const source = toSource(file)
  try {
    const plugin = await importPluginFile(file)
    const id = plugin.config.id
    const duplicate = seen.get(id)

    if (duplicate) {
      failures.push({ file: source, error: `插件 id "${id}" 与 ${duplicate} 重复，已跳过后一个` })
      continue
    }

    seen.set(id, source)
    entries.push({ source, plugin })
  } catch (error) {
    failures.push({ file: source, error: error instanceof Error ? error.message : String(error) })
  }
}

/** 全部内置插件。模块加载完成时已经就绪，运行期不再变化。 */
export const builtinPlugins: readonly BuiltinPluginEntry[] = entries

/** 加载失败的文件；没有失败时为空数组。 */
export const builtinPluginFailures: readonly BuiltinPluginFailure[] = failures
