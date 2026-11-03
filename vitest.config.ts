import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 测试统一在仓库根目录运行（test/ 与 web/test/）。
 * web 源码里的 `@webcrawler/shared` 别名保留，指向 src/shared 源码，
 * 前端只引用共享类型，无需先构建。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@webcrawler/shared': fileURLToPath(new URL('./src/shared/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // web 的测试文件用 `// @vitest-environment happy-dom` 单独切换环境
    include: ['test/**/*.test.ts', 'web/test/**/*.test.ts'],
    reporters: ['default'],
  },
})
