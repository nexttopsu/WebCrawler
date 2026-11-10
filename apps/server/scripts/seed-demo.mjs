/**
 * 第六阶段冒烟数据。
 *
 * 全部通过真实 API 写入，不直接改数据库；只用于本地演示与截图。
 * 用法（需先启动 fixture :4100 与后端 :3000）：
 *   node scripts/seed-demo.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api'

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`)
  }
  return payload.data ?? payload
}

const RULE = {
  version: 1,
  request: { mode: 'http', timeoutMs: 15000 },
  list: {
    url: 'http://127.0.0.1:4100/news',
    itemSelector: '.news-list .news-item',
    linkSelector: 'a.title',
    titleSelector: 'a.title',
    pagination: { type: 'none' },
  },
  detail: {
    fields: {
      title: { type: 'text', selector: 'h1.article-title' },
      author: { type: 'text', selector: '.author' },
      publishTime: { type: 'text', selector: '.publish-time' },
      content: { type: 'html', selector: '.article-content' },
    },
  },
  clean: { removeSelectors: ['.ad'] },
  // 详情只需 content 必填；标题优先取详情页 title 字段，抽不到时继承列表标题
  validate: { requiredFields: ['content'], minTitleLength: 2 },
}

async function main() {
  const existing = await call('GET', '/sites?pageSize=1')
  if (existing.total > 0) {
    console.log('已有数据，只补演示数据')
    await extras()
    return
  }

  const site = await call('POST', '/sites', {
    name: 'Fixture 演示站',
    domain: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:4100',
    description: '本地 fixture 站点，用于冒烟与演示',
  })
  console.log('site', site.id)

  const proxy = await call('POST', '/proxies', {
    name: '演示 HTTP 代理',
    type: 'http',
    host: '127.0.0.1',
    port: 18080,
    username: 'demo',
    password: 'demo-secret',
  })
  console.log('proxy', proxy.id)

  const rule = await call('POST', '/rules', {
    siteId: site.id,
    name: 'Fixture 列表 + 详情',
    description: '冒烟用规则：列表取 .news-item，详情取标题/作者/时间/正文',
    config: RULE,
  })
  console.log('rule', rule.id)

  const category = await call('POST', '/categories', {
    siteId: site.id,
    name: '要闻',
    code: 'news',
    listUrl: 'http://127.0.0.1:4100/news',
    ruleId: rule.id,
    description: '首页新闻列表',
  })
  console.log('category', category.id)

  const task = await call('POST', '/tasks', {
    siteId: site.id,
    type: 'category',
    categoryIds: [category.id],
    name: '冒烟：要闻采集',
  })
  console.log('task', task.id)

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    const detail = await call('GET', `/tasks/${task.id}`)
    if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
      console.log('task status', detail.status, JSON.stringify(detail.progress))
      break
    }
  }

  const articles = await call('GET', '/articles?pageSize=5')
  console.log('articles', articles.total)

  await extras()
}

/** 补充：失败任务 + 插件目录扫描（可重复执行）。 */
async function extras() {
  const sites = await call('GET', '/sites?pageSize=1')
  const site = sites.items[0]
  if (!site) throw new Error('没有站点，无法补演示数据')

  const existingCategories = await call('GET', `/categories?siteId=${site.id}&pageSize=50`)
  if (existingCategories.items.some((item) => item.code === 'broken')) {
    console.log('演示数据已存在')
    return
  }

  const rulesPage = await call('GET', `/rules?siteId=${site.id}&pageSize=100`)
  const existingRule = rulesPage.items.find((item) => item.name === 'Fixture 失效规则（演示错误）')
  const brokenRule = existingRule ?? (await call('POST', '/rules', {
    siteId: site.id,
    name: 'Fixture 失效规则（演示错误）',
    description: '选择器与页面不匹配，用来演示失败状态与日志',
    config: {
      version: 1,
      list: {
        url: 'http://127.0.0.1:4100/not-found-404',
        itemSelector: '.not-exists-item',
        linkSelector: 'a.title',
        pagination: { type: 'none' },
      },
      detail: { fields: { title: { type: 'text', selector: 'h1' } } },
    },
  }))
  const brokenCategory = await call('POST', '/categories', {
    siteId: site.id,
    name: '失效栏目',
    code: 'broken',
    listUrl: 'http://127.0.0.1:4100/not-found-404',
    ruleId: brokenRule.id,
  })
  const brokenTask = await call('POST', '/tasks', {
    siteId: site.id,
    type: 'category',
    categoryIds: [brokenCategory.id],
    name: '冒烟：选择器不匹配',
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const detail = await call('GET', `/tasks/${brokenTask.id}`)
    if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
      console.log('broken task status', detail.status)
      break
    }
  }

  // 插件全部内置：确认服务启动时已经把内置插件注册上（不需要扫描、不需要写文件）
  const plugins = await call('GET', '/plugins')
  console.log(
    'plugins',
    JSON.stringify(
      plugins.items.map((item) => ({ id: item.pluginId, type: item.type, slots: item.slots, status: item.status })),
    ),
  )

  console.log('DONE')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
