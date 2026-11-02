import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 测试统一在仓库根目录运行。
 * 工作空间包通过别名直接指向源码，避免测试依赖构建产物。
 */
const resolveWorkspacePath = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@webcrawler/shared', replacement: resolveWorkspacePath('./packages/shared/src/index.ts') },
      { find: '@webcrawler/database', replacement: resolveWorkspacePath('./packages/database/src/index.ts') },
      { find: '@webcrawler/request', replacement: resolveWorkspacePath('./packages/request/src/index.ts') },
      { find: '@webcrawler/core', replacement: resolveWorkspacePath('./packages/core/src/index.ts') },
      { find: '@webcrawler/plugins', replacement: resolveWorkspacePath('./packages/plugins/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    // apps/web 的测试文件用 `// @vitest-environment happy-dom` 单独切换环境
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/server/test/**/*.test.ts',
      'apps/web/test/**/*.test.ts',
    ],
    reporters: ['default'],
  },
})
