/**
 * 第六阶段 UI 冒烟。
 *
 * 覆盖：11 个导航页 + 2 个详情页的加载、控制台错误、主题切换、路由跳转、
 * 关键按钮行为（打开/关闭新建弹窗、切换筛选），并输出截图。
 *
 * 用法（需先启动后端 3000、fixture 4100、前端 5173）：
 *   node scripts/ui-smoke.mjs
 */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// playwright 声明在 packages/request（浏览器模式用），从这里解析即可
const requireFromRequest = createRequire(new URL('../packages/request/package.json', import.meta.url))
const { chromium } = requireFromRequest('playwright')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const OUT = process.env.SHOT_DIR ?? join(ROOT, 'tmp', 'screenshots')

const PAGES = [
  { path: '/', name: '01-dashboard', expect: '仪表盘' },
  { path: '/sites', name: '02-sites', expect: '网站管理' },
  { path: '/categories', name: '03-categories', expect: '栏目管理' },
  { path: '/rules', name: '04-rules', expect: '采集规则' },
  { path: '/tester', name: '05-tester', expect: '规则测试器' },
  { path: '/tasks', name: '06-tasks', expect: '采集任务' },
  { path: '/articles', name: '07-articles', expect: '文章数据' },
  { path: '/proxies', name: '08-proxies', expect: '代理管理' },
  { path: '/plugins', name: '09-plugins', expect: '插件管理' },
  { path: '/logs', name: '10-logs', expect: '日志中心' },
  { path: '/settings', name: '11-settings', expect: '系统设置' },
]

const problems = []

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  // 1) 逐页加载 + 截图
  for (const item of PAGES) {
    consoleErrors.length = 0
    await page.goto(`${ORIGIN}${item.path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)

    const heading = await page.locator('h1').first().textContent().catch(() => '')
    if (!heading || !heading.includes(item.expect)) {
      problems.push(`${item.path} 标题不是「${item.expect}」，实际「${heading}」`)
    }
    // 空白页检测：主内容区必须有内容
    const mainText = (await page.locator('main').first().innerText().catch(() => '')).trim()
    if (mainText.length < 20) problems.push(`${item.path} 主内容几乎为空`)

    await page.screenshot({ path: join(OUT, `${item.name}.png`), fullPage: true })
    if (consoleErrors.length > 0) {
      problems.push(`${item.path} 控制台错误：${consoleErrors.slice(0, 3).join(' | ')}`)
    }
  }

  // 2) 详情页：任务 + 文章
  await page.goto(`${ORIGIN}/tasks`, { waitUntil: 'networkidle' })
  const detailButton = page.getByRole('button', { name: '详情' }).first()
  if (await detailButton.count()) {
    await detailButton.click()
    await page.waitForURL(/\/tasks\/\d+/, { timeout: 8000 }).catch(() => problems.push('任务「详情」按钮没有跳转'))
  } else {
    problems.push('任务列表没有「详情」按钮')
  }
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT, '12-task-detail.png'), fullPage: true })
  if ((await page.locator('.el-progress').count()) === 0) problems.push('任务详情页没有进度条')
  if ((await page.locator('.task-progress').count()) === 0) problems.push('任务详情页没有进度区块')

  await page.goto(`${ORIGIN}/articles`, { waitUntil: 'networkidle' })
  const titleButton = page.locator('.cell-title--link').first()
  if (await titleButton.count()) {
    await titleButton.click()
    await page.waitForURL(/\/articles\/\d+/, { timeout: 8000 }).catch(() => problems.push('文章标题没有跳转详情'))
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(OUT, '13-article-detail.png'), fullPage: true })
    const article = await page.locator('.wb-article').count()
    if (article === 0) problems.push('文章详情页没有渲染正文')
    // 切到原始 HTML
    await page.getByRole('button', { name: /原始 HTML/ }).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(OUT, '14-article-raw.png'), fullPage: true })
  } else {
    problems.push('文章列表没有可点击的标题')
  }

  // 3) 主题切换
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' })
  const beforeClass = await page.locator('html').getAttribute('class')
  await page.locator('header button[title*="主题"]').first().click()
  await page.waitForTimeout(700)
  const afterClass = await page.locator('html').getAttribute('class')
  if (beforeClass === afterClass) problems.push('主题切换没有改变 html class')
  if (!afterClass?.includes('dark')) problems.push('切换到暗色后 html 没有 dark class')
  await page.screenshot({ path: join(OUT, '15-dashboard-dark.png'), fullPage: true })

  // 暗色下再走两个页面，确认 Token 覆盖生效
  await page.goto(`${ORIGIN}/articles`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: join(OUT, '16-articles-dark.png'), fullPage: true })

  // 切回浅色
  await page.locator('header button[title*="主题"]').first().click()
  await page.waitForTimeout(600)
  const backClass = await page.locator('html').getAttribute('class')
  if (backClass?.includes('dark')) problems.push('切回浅色失败')

  // 4) 侧边导航点击（路由跳转）
  await page.getByRole('link', { name: /网站管理/ }).first().click()
  await page.waitForURL(/\/sites$/, { timeout: 8000 }).catch(() => problems.push('侧边栏点击未跳转到网站管理'))
  await page.waitForTimeout(400)

  // 5) 关键按钮行为：新建网站弹窗
  await page.getByRole('button', { name: /新增网站|新建网站/ }).first().click()
  await page.waitForTimeout(500)
  const dialogVisible = await page.locator('.el-dialog').first().isVisible().catch(() => false)
  if (!dialogVisible) problems.push('「新增网站」没有打开弹窗')
  else {
    await page.screenshot({ path: join(OUT, '17-site-dialog.png') })
    await page.locator('.el-dialog__footer button').first().click()
    await page.waitForTimeout(400)
  }

  // 6) 设置页：改一个数值再撤销（验证交互与脏标记）
  await page.goto(`${ORIGIN}/settings`, { waitUntil: 'networkidle' })
  const saveButton = page.getByRole('button', { name: /保存/ }).first()
  if (!(await saveButton.isDisabled())) problems.push('设置页初始状态「保存」应禁用')
  const numberInput = page.locator('.el-input-number input').first()
  await numberInput.fill('3')
  await numberInput.blur()
  await page.waitForTimeout(400)
  if (await saveButton.isDisabled()) problems.push('改值后「保存」仍禁用')
  await page.screenshot({ path: join(OUT, '18-settings-dirty.png'), fullPage: true })
  await page.getByRole('button', { name: /撤销改动/ }).click()
  await page.waitForTimeout(400)
  if (!(await saveButton.isDisabled())) problems.push('「撤销改动」没有恢复到基线')

  // 7) 日志页筛选交互
  await page.goto(`${ORIGIN}/logs`, { waitUntil: 'networkidle' })
  await page.locator('.el-select').first().click()
  await page.waitForTimeout(300)
  await page.getByRole('option', { name: 'ERROR' }).click()
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT, '19-logs-error.png'), fullPage: true })

  // 8) 插件扫描弹窗
  await page.goto(`${ORIGIN}/plugins`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /扫描插件目录/ }).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, '20-plugin-scan.png') })

  // 9) 窄屏：侧栏应变成抽屉，不能常驻遮挡内容
  const narrowPage = await browser.newPage({ viewport: { width: 900, height: 900 } })
  narrowPage.on('console', (message) => {
    if (message.type() === 'error') problems.push(`窄屏控制台错误：${message.text()}`)
  })
  await narrowPage.goto(`${ORIGIN}/settings`, { waitUntil: 'networkidle' })
  await narrowPage.waitForTimeout(600)

  const sidebarVisible = await narrowPage.locator('.sidebar').isVisible()
  const sidebarBox = await narrowPage.locator('.sidebar').boundingBox()
  if (sidebarVisible && sidebarBox && sidebarBox.x >= 0) problems.push('窄屏下侧栏应移出视口')

  const menuButton = narrowPage.locator('.menu-btn')
  if (!(await menuButton.isVisible())) problems.push('窄屏下没有菜单按钮')

  await narrowPage.screenshot({ path: join(OUT, '21-narrow-closed.png') })

  await menuButton.click()
  await narrowPage.waitForTimeout(400)
  const drawerBox = await narrowPage.locator('.sidebar').boundingBox()
  if (!drawerBox || drawerBox.x < 0) problems.push('点击菜单后抽屉没有展开')
  if (!(await narrowPage.locator('.backdrop').isVisible())) problems.push('抽屉展开时缺少遮罩')
  await narrowPage.screenshot({ path: join(OUT, '22-narrow-open.png') })

  // 点导航应关闭抽屉
  await narrowPage.locator('.nav-item').first().click()
  await narrowPage.waitForTimeout(600)
  if (await narrowPage.locator('.backdrop').count()) problems.push('跳转后抽屉遮罩没有关闭')
  await narrowPage.close()

  await browser.close()

  if (problems.length > 0) {
    console.error('SMOKE PROBLEMS:')
    for (const problem of problems) console.error(' -', problem)
    process.exit(1)
  }
  console.log('SMOKE OK: 页面、主题、路由、按钮均通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
