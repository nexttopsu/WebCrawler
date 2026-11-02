/**
 * 第二阶段验收脚本：本地 fixture 站点上跑完整采集链路。
 *
 * 运行：
 *   pnpm --filter @webcrawler/core demo:crawl
 *
 * 输出：列表链接、每篇文章的 ArticleData、管道阶段与统计。
 * 全过程不访问任何第三方网站。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createRequestClient } from '@webcrawler/request'
import type { CrawlContext, CrawlRuleConfig, FieldRule } from '@webcrawler/shared'
import { createParser } from '../src/parser/index.js'
import { CrawlEngine } from '../src/engine.js'

const listHtml = readFileSync(new URL('../test/fixtures/list.html', import.meta.url), 'utf8')
const detailHtml = readFileSync(new URL('../test/fixtures/detail.html', import.meta.url), 'utf8')

const fields: Record<string, FieldRule> = {
  title: { type: 'text', selector: '.article-title', required: true },
  author: { type: 'text', selector: '.author' },
  publishTime: { type: 'text', selector: '.publish-time' },
  content: { type: 'html', selector: '.article-content' },
}

const rule: CrawlRuleConfig = {
  version: 1,
  request: { timeoutMs: 5000 },
  list: { itemSelector: '.news-item', linkSelector: '.title', titleSelector: '.title' },
  detail: { fields },
  clean: { removeSelectors: ['.ad'] },
  validate: { minContentLength: 10 },
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/'
  const send = (body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  if (path === '/list') return send(listHtml)
  if (path === '/news/1.html' || path === '/news/3.html') return send(detailHtml)
  if (path === '/news/2.html') return send('<html><body><p>这个页面没有标题</p></body></html>')
  res.writeHead(404).end('not found')
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const request = createRequestClient({ ssrf: { allowPrivateNetwork: true }, timeoutMs: 5000 })
const engine = new CrawlEngine({ request, parser: createParser() })

const context: CrawlContext = {
  site: { id: '1', name: '本地 fixture 站点', domain: '127.0.0.1', baseUrl: origin },
  category: { id: '10', siteId: '1', name: '新闻', listUrl: `${origin}/list` },
  rule: { version: 1, config: rule },
  url: `${origin}/list`,
  requestOptions: {},
  proxy: null,
  signal: new AbortController().signal,
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  metadata: {},
}

try {
  const result = await engine.crawlCategory(context)

  console.log('列表链接：')
  for (const link of result.links) {
    console.log(`  - ${link.title ?? '(无标题)'} -> ${link.url}`)
  }

  console.log('\n管道阶段：')
  for (const step of result.results[0]?.steps ?? []) {
    console.log(`  ${step.ok ? '✓' : '×'} ${step.stage} (${step.durationMs}ms) ${step.detail ?? ''}`)
  }

  console.log('\n第一篇文章：')
  console.log(JSON.stringify(result.articles[0], null, 2))

  console.log('\n统计：', result.stats)
  if (result.errors.length > 0) {
    console.log('错误：')
    for (const error of result.errors) {
      console.log(`  - [${error.stage}/${error.code}] ${error.url}: ${error.message}`)
    }
  }
} finally {
  request.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
