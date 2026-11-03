import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 后端测试（本包 test/）。
 * 前端测试在 apps/web/test/，由 apps/web 自己的 vitest 配置运行。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@webcrawler/shared': fileURLToPath(new URL('./src/shared/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
  },
})
