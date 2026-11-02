/**
 * 第四阶段界面冒烟：真实浏览器打开规则测试器，加载 fixture 列表页、
 * 点选 DOM、跑真实列表测试与详情测试，并截图到 docs/stage4-tester.png。
 *
 * 前置：pnpm fixture & 后端 :3000 & pnpm dev:web
 * 运行：node packages/request/scripts/smoke-tester.mjs
 */
import { chromium } from 'playwright'

const base = process.env.TESTER_BASE ?? 'http://localhost:5173'
const fixture = process.env.FIXTURE_URL ?? 'http://127.0.0.1:4100/news'
const detailUrl = fixture.replace(/\/news$/, '/article/1')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

await page.goto(`${base}/tester`, { waitUntil: 'networkidle' })
await page.getByPlaceholder('https://example.com/news').fill(fixture)
await page.getByRole('button', { name: '加载页面' }).click()

const frame = page.frameLocator('iframe.preview-frame')
await frame.locator('.news-item').first().waitFor({ timeout: 15000 })
console.log('preview loaded:', await frame.locator('.news-item').count(), 'items')

// 点选列表项容器的空白处，事件目标才是容器本身
await frame.locator('.news-item').first().click({ position: { x: 4, y: 4 } })
await page.waitForTimeout(300)
console.log('picked selector:', await page.locator('.selector-bar input').first().inputValue())
console.log('match badge:', (await page.locator('.match-badge').innerText()).trim())

// 容器点选容易落在子元素上，这里直接填 itemSelector 验证列表提取
await page.locator('.list-config input[placeholder=".news-item"]').fill('.news-item')

// 列表测试（真实引擎）
await page.getByRole('button', { name: '测试列表规则' }).click()
await page.locator('.test-summary').waitFor({ timeout: 15000 })
console.log('list summary:', (await page.locator('.test-summary').innerText()).trim())
console.log('link rows:', await page.locator('.links a, .links .link-item').count())

await page.screenshot({ path: '../../docs/stage4-tester.png' })

// 详情测试：添加内置字段，填选择器，跑真实解析
await page.getByRole('tab', { name: /详情规则/ }).click()
await page.locator('.detail-url-row input').fill(detailUrl)

for (const label of ['标题', '正文']) {
  await page.getByRole('button', { name: '添加内置字段' }).click()
  await page.getByRole('menuitem', { name: new RegExp(label) }).click()
}

const selectorInputs = page.locator('.field-panel input[placeholder=".article-title"]')
const headers = page.locator('.field-panel .el-collapse-item__header')
await headers.nth(0).click()
await selectorInputs.nth(0).fill('h1.article-title')
await headers.nth(1).click()
await selectorInputs.nth(1).fill('.article-content')

await page.getByRole('button', { name: '测试详情规则' }).click()
await page.locator('.detail-result .summary').waitFor({ timeout: 15000 })
console.log('detail summary:', (await page.locator('.detail-result .summary').innerText()).trim())
console.log('field rows:', await page.locator('.field-table tbody tr').count())

await page.screenshot({ path: '../../docs/stage4-tester-detail.png' })
console.log('console errors:', errors.filter((item) => !item.includes('favicon')).slice(0, 5))
await browser.close()
