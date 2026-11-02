/**
 * 本地 fixture 站点（测试用包装）。
 *
 * 页面内容统一来自仓库根目录的 `scripts/fixture-site.mjs`：
 * 自动化测试与手动验收（pnpm fixture）使用同一份页面，
 * 避免「测试能过、手动验收对不上」。
 */
import type { FixtureServer } from '../../../../scripts/fixture-site.mjs'
import { startFixture } from '../../../../scripts/fixture-site.mjs'

export interface SiteFixture {
  origin: string
  close(): Promise<void>
}

export async function startSiteFixture(): Promise<SiteFixture> {
  const fixture: FixtureServer = await startFixture()
  return { origin: fixture.origin, close: fixture.close }
}
