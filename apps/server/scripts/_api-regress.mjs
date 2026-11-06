const API = 'http://127.0.0.1:3000/api'
const stamp = Date.now().toString().slice(-6)
const created = []
let pass = 0
let fail = 0

async function req(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let payload = null
  try { payload = await r.json() } catch { payload = null }
  return { status: r.status, body: payload }
}

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

async function createSite(name, domain) {
  const res = await req('POST', '/sites', { name, domain, baseUrl: `https://${domain}` })
  if (res.status !== 201) throw new Error(`创建站点失败 ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data
}
async function createCategory(body) {
  const res = await req('POST', '/categories', body)
  if (res.status !== 201) throw new Error(`创建栏目失败 ${res.status} ${JSON.stringify(res.body)}`)
  created.push(res.body.data.id)
  return res.body.data
}

try {
  console.log('\n[1] 层级创建与树结构')
  const site = await createSite(`回归站 ${stamp}`, `regress-${stamp}.example.com`)
  const root = await createCategory({ siteId: site.id, name: '关于我们', listUrl: `https://${site.domain}/about`, sortOrder: 2 })
  const root2 = await createCategory({ siteId: site.id, name: '剧院动态', listUrl: `https://${site.domain}/news`, sortOrder: 1 })
  const child = await createCategory({ siteId: site.id, parentId: root.id, name: '剧院介绍', listUrl: `https://${site.domain}/intro`, sortOrder: 1 })
  const grand = await createCategory({ siteId: site.id, parentId: child.id, name: '公告1', listUrl: `https://${site.domain}/notice1`, sortOrder: 1 })

  let tree = (await req('GET', `/categories/tree?siteId=${site.id}`)).body.data
  check('顶级按 sortOrder 排序（剧院动态在关于我们之前）', tree.map((n) => n.id).join(',') === [root2.id, root.id].join(','), JSON.stringify(tree.map((n) => n.name)))
  check('子栏目挂在正确父级', tree[1].children[0].id === child.id)
  check('孙栏目挂在子栏目下', tree[1].children[0].children[0].id === grand.id)
  check('parentId 正确回传', tree[1].children[0].parentId === root.id && tree[1].children[0].children[0].parentId === child.id)

  console.log('\n[2] 编辑路径')
  const patchName = await req('PATCH', `/categories/${grand.id}`, { name: '公告一' })
  check('PATCH 不带 siteId 可成功', patchName.status === 200 && patchName.body.data.name === '公告一', `${patchName.status}`)
  const patchSite = await req('PATCH', `/categories/${grand.id}`, { siteId: site.id })
  check('PATCH 带 siteId 被拒（400）', patchSite.status === 400, `${patchSite.status} ${JSON.stringify(patchSite.body?.error?.message)}`)
  const move = await req('PATCH', `/categories/${grand.id}`, { parentId: root.id })
  check('调整上级成功', move.status === 200 && move.body.data.parentId === root.id)
  const detach = await req('PATCH', `/categories/${grand.id}`, { parentId: null })
  check('置顶成功', detach.status === 200 && detach.body.data.parentId === null)
  const sortPatch = await req('PATCH', `/categories/${root.id}`, { sortOrder: 0 })
  tree = (await req('GET', `/categories/tree?siteId=${site.id}`)).body.data
  check('改排序后树顺序变化', sortPatch.status === 200 && tree[0].id === root.id, JSON.stringify(tree.map((n) => n.name)))

  console.log('\n[3] 非法层级')
  const siteB = await createSite(`回归站B ${stamp}`, `regressb-${stamp}.example.com`)
  const selfParent = await req('PATCH', `/categories/${root.id}`, { parentId: root.id })
  check('不能设自己为上级（400）', selfParent.status === 400 && JSON.stringify(selfParent.body).includes('parentId'))
  const cycle = await req('PATCH', `/categories/${root.id}`, { parentId: child.id })
  check('不能成环（400）', cycle.status === 400)
  const cross = await req('POST', '/categories', { siteId: siteB.id, parentId: root.id, name: '跨站子', listUrl: `https://${siteB.domain}/x` })
  check('上级必须同站点（400）', cross.status === 400)
  const missingParent = await req('POST', '/categories', { siteId: siteB.id, parentId: 999999, name: '不存在父', listUrl: `https://${siteB.domain}/y` })
  check('上级不存在（400 且定位 parentId）', missingParent.status === 400 && missingParent.body?.error?.details?.[0]?.path === 'parentId', `${missingParent.status} ${JSON.stringify(missingParent.body?.error?.details)}`)

  console.log('\n[4] 删除保护')
  const delRoot = await req('DELETE', `/categories/${root.id}`)
  check('有子栏目时删除被拒（409）', delRoot.status === 409)
  check('409 返回子栏目数量', delRoot.body?.error?.details?.counts?.children >= 1, JSON.stringify(delRoot.body?.error?.details))
  const delLeaf = await req('DELETE', `/categories/${grand.id}`)
  check('叶子栏目可删除（200）', delLeaf.status === 200)

  console.log('\n[5] 兼容性')
  const list = await req('GET', `/categories?siteId=${site.id}&pageSize=10`)
  check('列表接口仍按分页返回', list.status === 200 && Array.isArray(list.body.data.items) && typeof list.body.data.total === 'number')
  const search = await req('GET', `/categories?keyword=${encodeURIComponent('剧院')}&pageSize=10`)
  check('列表搜索仍可用', search.status === 200 && search.body.data.items.length >= 1)
  const treeAll = await req('GET', '/categories/tree')
  check('tree 不带 siteId 返回全部站点', treeAll.status === 200 && treeAll.body.data.some((n) => n.siteId === siteB.id) === false)
  const statusPatch = await req('PATCH', `/categories/${child.id}/status`, { enabled: false })
  check('启停接口未受影响', statusPatch.status === 200 && statusPatch.body.data.enabled === false)

  console.log('\n[6] 父栏目自身仍可采集')
  const ruleRes = await req('POST', '/rules', {
    siteId: site.id,
    name: `回归规则 ${stamp}`,
    config: {
      version: 1,
      request: { mode: 'http', method: 'GET', timeoutMs: 5000 },
      list: { itemSelector: '.news-item', linkSelector: 'a', titleSelector: '.title', pagination: { type: 'none' } },
      detail: { fields: { title: { type: 'text', selector: 'h1', required: true }, content: { type: 'html', selector: '.content' } } },
    },
  })
  if (ruleRes.status !== 201) console.log('  规则创建失败:', ruleRes.status, JSON.stringify(ruleRes.body))
  await req('PATCH', `/sites/${site.id}`, { defaultRuleId: ruleRes.body.data.id })
  const task = await req('POST', '/tasks', { siteId: site.id, name: `父栏目任务 ${stamp}`, type: 'category', categoryIds: [root.id] })
  check('可为父栏目单独建任务（仅自身）', task.status === 201, `${task.status} ${JSON.stringify(task.body?.error?.message ?? '')}`)
  if (task.status === 201) {
    const snapshot = task.body.data
    check('任务快照只含所选栏目', JSON.stringify(snapshot).includes(String(root.id)))
    await req('DELETE', `/tasks/${snapshot.id}`)
  }

  await req('DELETE', `/sites/${siteB.id}`).catch(() => {})
} catch (error) {
  fail += 1
  console.log('脚本异常:', error.message)
} finally {
  for (const id of [...created].reverse()) {
    const r = await req('DELETE', `/categories/${id}`).catch(() => null)
    if (r && r.status >= 400) console.log(`清理栏目 ${id} 失败: ${r.status}`)
  }
  console.log(`\n结果：通过 ${pass}，失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}
