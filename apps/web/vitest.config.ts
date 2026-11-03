import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 前端测试（本包 test/）。
 * 测试文件用 `// @vitest-environment happy-dom` 单独切换 DOM 环境。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@webcrawler/shared': fileURLToPath(
        new URL('../server/src/shared/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
  },
})
