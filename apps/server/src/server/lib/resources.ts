/**
 * 静态资源目录（仓库根 `resources/`）的定位与托管。
 *
 * - 目录定位：默认「仓库根/resources」，可用环境变量 `RESOURCES_DIR` 覆盖。
 *   仓库根从进程工作目录向上找 `pnpm-workspace.yaml` 确定，dev / 生产构建都成立；
 * - 托管：`GET /resources/**` 直接读取该目录下的文件，
 *   由 `app.ts` 注册在兜底路由之前；不存在时抛统一的 `NotFoundError`；
 * - 安全：解析路径后断言仍在资源根内，拒绝目录穿越；
 *   `serveStatic` 自身还会拒绝非规范路径（`//x`、`%2e%2e` 等）。
 */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { serveStatic, type H3Event } from 'h3'
import { NotFoundError } from '../errors.js'

/** URL 前缀：与 app.ts 注册的路由保持一致。 */
export const RESOURCES_URL_PREFIX = '/resources'

/**
 * 从起始目录向上查找仓库根（含 `pnpm-workspace.yaml` 的目录）。
 * 找不到时退回起始目录，保证测试与独立运行也不会崩。
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir)
  for (;;) {
    if (existsPnpmWorkspace(dir)) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return resolve(startDir)
    dir = parent
  }
}

function existsPnpmWorkspace(dir: string): boolean {
  return existsSync(resolve(dir, 'pnpm-workspace.yaml'))
}

/** 静态资源目录：默认仓库根下的 `resources/`，可用 `RESOURCES_DIR` 覆盖。 */
export function resolveResourcesDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.RESOURCES_DIR?.trim()
  if (custom) return resolve(custom)
  return resolve(findWorkspaceRoot(), 'resources')
}

/** h3 内置 MIME 表缺少的补充项；其余格式交给 serveStatic 内置表。 */
const EXTRA_MIME_TYPES: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/** 创建 `GET /resources/**` 处理器：把 URL 映射到资源目录下的文件。 */
export function createResourcesHandler(resourcesDir: string = resolveResourcesDir()) {
  const root = resolve(resourcesDir)

  /** 在资源根内解析相对路径；越界返回 undefined。 */
  const safeJoin = (relativePath: string): string | undefined => {
    const target = resolve(root, relativePath)
    if (target === root || target.startsWith(root + '\\') || target.startsWith(root + '/')) {
      return target
    }
    return undefined
  }

  return async function serveResources(event: H3Event) {
    const response = await serveStatic(event, {
      fallthrough: true,
      getMeta: async (id) => {
        const filePath = mapIdToPath(id)
        if (!filePath) return undefined
        try {
          const stats = await stat(filePath)
          return stats.isFile() ? { mtime: stats.mtimeMs, size: stats.size } : undefined
        } catch {
          return undefined
        }
      },
      getContents: async (id) => {
        const filePath = mapIdToPath(id)
        return filePath ? await readFile(filePath) : undefined
      },
      getType: (ext) => EXTRA_MIME_TYPES[ext.toLowerCase()],
    })

    if (!response) throw new NotFoundError('静态资源不存在')
    return response
  }

  /** 把 `/resources/**` 的完整 pathname 映射为资源根内的文件路径；非法返回 undefined。 */
  function mapIdToPath(id: string): string | undefined {
    if (!id.startsWith(RESOURCES_URL_PREFIX)) return undefined
    const rest = id.slice(RESOURCES_URL_PREFIX.length)
    if (!rest.startsWith('/') || rest.includes('\0')) return undefined
    return safeJoin(`.${rest}`)
  }
}
