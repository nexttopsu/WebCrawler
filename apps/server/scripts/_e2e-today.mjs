import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import('playwright')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const API = 'http://127.0.0.1:3000/api'
const OUT = join(ROOT, 'tmp', 'e2e')
const stamp = Date.now().toString().slice(-4)
const created = []
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

async function req(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await r.json().catch(() => null)
  return { status: r.status, body: payload }
}

async function mkCategory(body) {
  const res = await req('POST', '/categories', body)
  if (res.status !== 201) throw new Error(`创建栏目失败 ${res.status} ${JSON.stringify(res.body?.error)}`)
  created.push(res.body.data.id)
  return res.body.data
}

const N = (s) => `E2E${stamp}·${s}`
const url = (p) => `https://www.cntc.org.cn/e2e-${stamp}/${p}`

const visibleOptions = async (page) =>
  page.$$eval('.el-select-dropdown:visible .el-select-dropdown__item', (els) =>
    els.map((e) => ({ text: e.textContent.trim(), disabled: e.classList.contains('is-disabled') })),
  )

async function openSelectByPlaceholder(page, placeholder) {
  await page.locator(`.el-select:has(input[placeholder*="${placeholder}"])`).first().click()
  await page.waitForTimeout(500)
}

try {
  await mkdir(OUT, { recursive: true })
  console.log('\n[准备] 建一棵三级的临时栏目树')
  const rootA = await mkCategory({ siteId: 1, name: N('关于我们'), listUrl: url('about'), sortOrder: -9 })
  const childA1 = await mkCategory({ siteId: 1, parentId: rootA.id, name: N('剧院介绍'), listUrl: url('intro'), sortOrder: 1 })
  const childA2 = await mkCategory({ siteId: 1, parentId: rootA.id, name: N('现任领导'), listUrl: url('leader'), sortOrder: 2 })
  const rootB = await mkCategory({ siteId: 1, name: N('剧院动态'), listUrl: url('news'), sortOrder: -8 })
  const childB1 = await mkCategory({ siteId: 1, parentId: rootB.id, name: N('儿艺新闻'), listUrl: url('news1'), sortOrder: 1 })
  const childB2 = await mkCategory({ siteId: 1, parentId: rootB.id, name: N('儿艺公告'), listUrl: url('notice'), sortOrder: 2, enabled: false })
  const grand = await mkCategory({ siteId: 1, parentId: childB2.id, name: N('公告1'), listUrl: url('notice1'), sortOrder: 1 })
  check('临时树创建成功（3 级 + 1 个停用栏目）', created.length === 7)
  // 临时树建在站点 1 下；站点下拉里可能有别的站点排在第一，按名称定位而不是点第一个
  const siteName = (await req('GET', '/sites/1')).body?.data?.name ?? '站点 1'

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 160)) })

  /* ---------------------------- A. 栏目管理列表 ---------------------------- */
  console.log('\n[A] 栏目管理：树形、缩进、归属路径')
  await page.goto('http://localhost:5173/categories', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT, 'a-categories.png'), fullPage: true })

  const rows = await page.$$eval('.el-table__body tr', (trs) =>
    trs.map((tr) => {
      const title = tr.querySelector('.cell-title')
      const sub = tr.querySelector('.cell-sub')
      return {
        name: title?.textContent.trim() ?? '',
        sub: sub?.textContent.trim() ?? '',
        left: title ? Math.round(title.getBoundingClientRect().left) : -1,
        hasArrow: Boolean(tr.querySelector('.el-table__expand-icon, .el-icon')),
      }
    }),
  )
  const byName = (n) => rows.find((r) => r.name === N(n))
  check('7 个临时栏目都渲染出来', ['关于我们', '剧院介绍', '现任领导', '剧院动态', '儿艺新闻', '儿艺公告', '公告1'].every((n) => byName(n)))
  check('子栏目的名称左边距大于父栏目', byName('剧院介绍') && byName('关于我们') && byName('剧院介绍').left > byName('关于我们').left, `${byName('剧院介绍')?.left} vs ${byName('关于我们')?.left}`)
  check('孙栏目缩进再深一级', byName('公告1').left > byName('儿艺公告').left, `${byName('公告1').left} vs ${byName('儿艺公告').left}`)
  check('父栏目有展开箭头', byName('关于我们').hasArrow)
  check('顶级栏目副标题只有站点名', byName('关于我们').sub === '儿艺', byName('关于我们').sub)
  check('二级栏目副标题含上级路径', byName('剧院介绍').sub === `儿艺 · ${N('关于我们')}`, byName('剧院介绍').sub)
  check('三级栏目副标题含完整路径', byName('公告1').sub === `儿艺 · ${N('剧院动态')} / ${N('儿艺公告')}`, byName('公告1').sub)

  console.log('\n[B] 搜索与筛选不打断层级')
  await page.getByPlaceholder('搜索栏目名称或地址').fill('公告1')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  const searchRows = await page.$$eval('.el-table__body tr .cell-title', (els) => els.map((e) => e.textContent.trim()))
  check('搜索命中子栏目', searchRows.includes(N('公告1')))
  check('搜索时保留祖先（剧院动态 / 儿艺公告）', searchRows.includes(N('剧院动态')) && searchRows.includes(N('儿艺公告')), JSON.stringify(searchRows.filter((t) => t.startsWith('E2E'))))
  check('搜索时隐藏无关分支', !searchRows.includes(N('关于我们')))
  await page.getByPlaceholder('搜索栏目名称或地址').fill('')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)

  const filterSelects = page.locator('.filter-bar .el-select')
  await filterSelects.last().click()
  await page.waitForTimeout(400)
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '停用' }).click()
  await page.waitForTimeout(700)
  const disabledRows = await page.$$eval('.el-table__body tr .cell-title', (els) => els.map((e) => e.textContent.trim()))
  check('筛选停用只显示停用栏目', disabledRows.includes(N('儿艺公告')) && !disabledRows.includes(N('儿艺新闻')), JSON.stringify(disabledRows.filter((t) => t.startsWith('E2E'))))
  check('停用筛选保留其上级以便定位', disabledRows.includes(N('剧院动态')))
  // 状态下拉没有「全部状态」选项，直接重载页面复位筛选
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)

  /* ------------------------- C. 新建弹窗与上级选择器 ------------------------- */
  console.log('\n[C] 新建弹窗：上级选择器、排序、站点可改')
  await page.getByRole('button', { name: '新建栏目' }).first().click()
  await page.waitForSelector('.el-dialog', { state: 'visible' })
  await page.waitForTimeout(500)
  const dialogSelects = page.locator('.el-dialog .el-select')
  check('新建时「所属网站」可编辑', !(await dialogSelects.nth(0).locator('input').isDisabled()))
  await dialogSelects.nth(0).click()
  await page.waitForTimeout(400)
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: siteName }).first().click()
  await page.waitForTimeout(500)

  await dialogSelects.nth(1).click()
  await page.waitForTimeout(600)
  const parentOptions = await visibleOptions(page)
  await page.screenshot({ path: join(OUT, 'c-parent-dropdown.png') })
  const texts = parentOptions.map((o) => o.text)
  const idxRootA = texts.findIndex((t) => t.includes(N('关于我们')))
  const idxChildA1 = texts.findIndex((t) => t.includes(N('剧院介绍')))
  check('上级下拉包含本树全部栏目', idxRootA >= 0 && idxChildA1 >= 0)
  check('上级下拉按层级顺序展开（父在子前）', idxRootA >= 0 && idxRootA < idxChildA1)
  check('子栏目选项带 └ 缩进标记', parentOptions.some((o) => o.text.includes('└')))
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: N('关于我们') }).click()
  await page.waitForTimeout(400)

  const sortInput = page.locator('.el-dialog .el-input-number input').first()
  check('弹窗有排序输入框', await sortInput.count() > 0)
  await page.getByPlaceholder('例如：要闻').fill(N('新建子'))
  await page.getByPlaceholder('https://example.com/news').fill(url('newchild'))
  await sortInput.fill('3')
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(1500)
  const toastCreate = await page.locator('.el-message').last().innerText().catch(() => '')
  check('新建子栏目保存成功', toastCreate.includes('已创建'), toastCreate)
  await page.waitForTimeout(800)
  const afterCreate = await page.$$eval('.el-table__body tr', (trs) =>
    trs.map((tr) => ({ name: tr.querySelector('.cell-title')?.textContent.trim(), sub: tr.querySelector('.cell-sub')?.textContent.trim() })),
  )
  const newRow = afterCreate.find((r) => r.name === N('新建子'))
  check('新栏目出现在列表中', Boolean(newRow))
  check('新栏目带正确上级路径', newRow?.sub === `${siteName} · ${N('关于我们')}`, newRow?.sub)

  /* ------------------------------ D. 编辑弹窗 ------------------------------ */
  console.log('\n[D] 编辑弹窗：站点锁定 + 改上级')
  const editRow = page.locator('.el-table__body tr', { hasText: N('公告1') })
  await editRow.getByRole('button', { name: '编辑' }).click()
  await page.waitForSelector('.el-dialog', { state: 'visible' })
  await page.waitForTimeout(500)
  const editSelects = page.locator('.el-dialog .el-select')
  check('编辑时「所属网站」置灰', await editSelects.nth(0).locator('input').isDisabled())
  const hintShown = await page.locator('.el-dialog').innerText()
  check('编辑时提示站点不可修改', hintShown.includes('站点归属创建后不可修改'))
  await page.screenshot({ path: join(OUT, 'd-edit-dialog.png') })
  await editSelects.nth(0).locator('xpath=ancestor::div[contains(@class,"el-select")]').count().catch(() => 0)

  await editSelects.nth(1).click()
  await page.waitForTimeout(600)
  const editOptions = await visibleOptions(page)
  const selfDisabled = editOptions.find((o) => o.text.includes(N('公告1')))
  check('编辑时自己在下拉中置灰', Boolean(selfDisabled?.disabled), JSON.stringify(selfDisabled))
  const ancestorDisabled = editOptions.find((o) => o.text.includes(N('剧院动态')))
  check('编辑时自己的祖先可选（不会误禁）', !ancestorDisabled?.disabled)
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: N('关于我们') }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(1500)
  const toastEdit = await page.locator('.el-message').last().innerText().catch(() => '')
  check('编辑保存成功（此前的 siteId 报错已修复）', toastEdit.includes('已更新'), toastEdit)
  await page.waitForTimeout(600)
  const movedSub = await page.$eval('.el-table__body tr:has-text("公告1") .cell-sub', (el) => el.textContent.trim()).catch(() => '')
  check('改上级后归属路径更新', movedSub === `${siteName} · ${N('关于我们')}`, movedSub)

  /* ------------------------------ E. 删除守卫 ------------------------------ */
  console.log('\n[E] 删除守卫')
  // 注意 hasText 会命中副标题里含「关于我们」的子行，必须用 .first() 锁定树序第一行
  const guardRow = page.locator('.el-table__body tr', { hasText: N('关于我们') }).first()
  await guardRow.locator('.row-actions button').last().click()
  await page.waitForTimeout(700)
  const confirmBox = await page.locator('.el-dialog:visible').last().innerText().catch(() => '')
  check('父栏目删除弹窗提示有子栏目', confirmBox.includes('子栏目'), confirmBox.slice(0, 80))
  const confirmDisabled = await page.locator('.el-dialog:visible').last().locator('button.el-button--danger, button.el-button--primary').last().isDisabled().catch(() => null)
  check('删除按钮被禁用', confirmDisabled === true, String(confirmDisabled))
  await page.screenshot({ path: join(OUT, 'e-delete-guard.png') })
  await page.locator('.el-dialog:visible').last().getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(400)

  /* ------------------------- F. 文章页通用栏目选择器 ------------------------- */
  console.log('\n[F] 文章数据：通用选择器（站点前缀 + 缩进 + 选中回显）')
  await page.goto('http://localhost:5173/articles', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.locator('.filter-bar .el-select').nth(1).click()
  await page.waitForTimeout(600)
  const articleOptions = await visibleOptions(page)
  await page.screenshot({ path: join(OUT, 'f-articles-select.png'), fullPage: true })
  const optTexts = articleOptions.map((o) => o.text)
  const firstName = optTexts.find((t) => t.includes(N('关于我们')))
  check('未选站点时选项带站点前缀', Boolean(firstName && firstName.startsWith('儿艺')), firstName)
  check('选项按排序值靠前展示（sortOrder -9 在最前）', optTexts.findIndex((t) => t.includes(N('关于我们'))) <= 1, JSON.stringify(optTexts.slice(0, 3)))
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: N('公告1') }).click()
  await page.waitForTimeout(900)
  const selectedText = await page.locator('.filter-bar .el-select').nth(1).innerText()
  check('选中后回显完整路径', selectedText.includes(N('关于我们')) && selectedText.includes(N('公告1')), selectedText.replace(/\n/g, ' '))
  await page.screenshot({ path: join(OUT, 'f-articles-selected.png') })

  /* --------------------------- G. 任务页多选（仅启用） --------------------------- */
  console.log('\n[G] 任务创建：简化弹窗 + 栏目多选')
  await page.goto('http://localhost:5173/tasks', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /新建任务|创建任务/ }).first().click()
  await page.waitForSelector('.el-dialog', { state: 'visible' })
  await page.waitForTimeout(500)
  const dialogText = await page.locator('.el-dialog:visible').innerText()
  check('弹窗无「任务类型」', !dialogText.includes('任务类型'))
  check('弹窗无「所属网站」', !dialogText.includes('所属网站'))
  check('弹窗无「跟随规则」', !dialogText.includes('跟随规则'))
  check('弹窗无「按规则翻页」', !dialogText.includes('按规则翻页'))
  check('弹窗无「文章时间下限」', !dialogText.includes('文章时间下限'))
  check('采集范围只有 列表+详情 / 仅列表', dialogText.includes('列表 + 详情') && dialogText.includes('仅列表'))
  const taskSelects = page.locator('.el-dialog .el-select')
  await taskSelects.nth(0).click()
  await page.waitForTimeout(400)
  // 多选模式下点选后下拉不关闭，选项会随站点锁定原地刷新
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: siteName }).first().click()
  await page.waitForTimeout(700)
  const taskOptions = await visibleOptions(page)
  const taskTexts = taskOptions.map((o) => o.text)
  await page.screenshot({ path: join(OUT, 'g-task-select.png') })
  check('选中后锁定同站栏目（无跨站前缀）', taskTexts.every((t) => !t.includes(' / ')), JSON.stringify(taskTexts.slice(0, 3)))
  check('停用栏目不出现在任务下拉', !taskTexts.some((t) => t.includes(N('儿艺公告'))), JSON.stringify(taskTexts.filter((t) => t.includes('E2E'))))
  check('停用栏目下的启用子栏目仍可选', taskTexts.some((t) => t.includes(N('公告1'))))
  check('任务下拉保留缩进', taskTexts.some((t) => t.includes('└')))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  /* ------------------------------ H. 规则页绑定 ------------------------------ */
  console.log('\n[H] 规则页：绑定栏目下拉')
  await page.goto('http://localhost:5173/rules', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /新建规则|创建规则/ }).first().click().catch(() => {})
  await page.waitForTimeout(800)
  const ruleDialog = page.locator('.el-dialog:visible').last()
  if (await ruleDialog.count()) {
    const ruleSelects = ruleDialog.locator('.el-select')
    await ruleSelects.nth(0).click()
    await page.waitForTimeout(400)
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '儿艺' }).first().click()
    await page.waitForTimeout(500)
    await ruleSelects.nth(1).click()
    await page.waitForTimeout(600)
    const ruleOptions = (await visibleOptions(page)).map((o) => o.text)
    await page.screenshot({ path: join(OUT, 'h-rule-select.png') })
    check('规则绑定栏目下拉有数据', ruleOptions.some((t) => t.includes(N('关于我们'))), JSON.stringify(ruleOptions.slice(0, 4)))
    check('规则绑定下拉带缩进', ruleOptions.some((t) => t.includes('└')))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  } else {
    check('规则页打开新建弹窗', false, '未找到弹窗')
  }
  await page.waitForTimeout(400)

  /* ---------------------------- I. 规则测试器 ---------------------------- */
  console.log('\n[I] 规则测试器：保存面板关联栏目')
  await page.goto('http://localhost:5173/rule-tester', { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(1200)
  const testerBody = await page.locator('body').innerText()
  check('规则测试器页面可访问', testerBody.includes('测试') || testerBody.includes('规则'))
  await page.screenshot({ path: join(OUT, 'i-tester.png'), fullPage: true })

  check('页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  await browser.close()
} catch (error) {
  fail += 1
  console.log('脚本异常:', error.message, error.stack?.split('\n')[1] ?? '')
} finally {
  // 清理：先删新建的，再倒序删整棵树（此时无子节点）
  for (const id of [...created].reverse()) {
    const r = await req('DELETE', `/categories/${id}`).catch(() => null)
    if (r && r.status >= 400) console.log(`  清理栏目 ${id}: ${r.status}`)
  }
  // UI 里新建的栏目不在 created 里，按名称前缀兜底清理
  const left = await req('GET', `/categories?keyword=${encodeURIComponent(`E2E${stamp}`)}&pageSize=50`)
  for (const item of (left.body?.data?.items ?? []).slice().reverse()) {
    const r = await req('DELETE', `/categories/${item.id}`).catch(() => null)
    if (r && r.status >= 400) console.log(`  兜底清理 ${item.id} ${item.name}: ${r.status}`)
  }
  // 兜底清掉 UI 子栏目后，再补删一轮（此前因存在子节点而 409 的父栏目）
  for (const id of [...created].reverse()) {
    await req('DELETE', `/categories/${id}`).catch(() => null)
  }
  console.log(`\n结果：通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}
