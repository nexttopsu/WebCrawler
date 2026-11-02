/**
 * WebCrawler 本地 fixture 站点。
 *
 * 用途：
 * - 第四阶段验收（可视化规则测试器）与自动化测试共用同一份页面；
 * - 不访问外网，路由固定、内容稳定；
 * - 故意包含 XSS 样本（script / onerror / javascript:）用于验证预览清洗。
 *
 * 启动：pnpm fixture   （默认 127.0.0.1:4100，可用 FIXTURE_PORT 覆盖）
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const ARTICLES = [
  {
    id: 1,
    title: '第一篇报道：城市更新',
    author: '记者甲',
    time: '2026-01-01 09:00',
    paragraphs: ['城市更新项目在本月启动。', '居民代表参与了方案讨论。'],
  },
  {
    id: 2,
    title: '第二篇报道：轨道交通',
    author: '记者乙',
    time: '2026-01-02 10:30',
    paragraphs: ['新线路进入试运行阶段。', '预计下月正式开通。'],
  },
  {
    id: 3,
    title: '第三篇报道：社区服务',
    author: '记者丙',
    time: '2026-01-03 14:15',
    paragraphs: ['社区服务中心延长开放时间。', '新增多项便民业务。'],
  },
  {
    id: 4,
    title: '第四篇报道：生态治理',
    author: '记者丁',
    time: '2026-01-04 08:45',
    paragraphs: ['河道治理完成阶段验收。', '水质指标持续改善。'],
  },
  {
    id: 5,
    title: '第五篇报道：数字政务',
    author: '记者戊',
    time: '2026-01-05 16:20',
    paragraphs: ['政务事项实现线上办理。', '平均办理时长缩短一半。'],
  },
]

const PAGE_HEAD = (title) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>`

/** 列表页：包含重复链接、javascript: 链接、script 与 onerror 等 XSS 样本。 */
function listPage() {
  const items = ARTICLES.map(
    (article) => `      <div class="news-item">
        <a class="title" href="/article/${article.id}">${article.title}</a>
        <span class="time">${article.time}</span>
      </div>`,
  ).join('\n')

  return `${PAGE_HEAD('新闻列表 - Fixture 站点')}
  <body>
    <script>window.__fixture_xss = 'inline-script-ran'</script>
    <header class="site-header">
      <a href="/">首页</a>
      <a href="/paged?page=1">分页列表</a>
    </header>
    <main>
      <h1>最新报道</h1>
      <img src="/images/missing.png" onerror="window.__fixture_xss='onerror-ran'" alt="" />
      <p><a href="javascript:alert('xss')">危险链接</a></p>
      <div class="news-list">
${items}
        <div class="news-item">
          <a class="title" href="/article/1">重复的第一篇</a>
          <span class="time">2026-01-01 09:00</span>
        </div>
        <div class="news-item">
          <a class="title" href="javascript:void(0)">无效链接</a>
          <span class="time">2026-01-06 00:00</span>
        </div>
      </div>
      <nav class="pagination"><a class="next" href="/paged?page=2">下一页</a></nav>
    </main>
  </body>
</html>`
}

/** 页码分页列表：?page=1..3，每页 2 条。 */
function pagedPage(page) {
  const pageSize = 2
  const start = (page - 1) * pageSize
  const slice = ARTICLES.slice(start, start + pageSize)
  const items = slice
    .map(
      (article) => `      <li class="post">
        <a class="post-link" href="/article/${article.id}">${article.title}</a>
      </li>`,
    )
    .join('\n')

  return `${PAGE_HEAD(`分页列表 第 ${page} 页`)}
  <body>
    <div class="post-list">
${items}
    </div>
    <nav class="pagination">
      ${page > 1 ? `<a class="prev" href="/paged?page=${page - 1}">上一页</a>` : ''}
      ${page < 3 ? `<a class="next" href="/paged?page=${page + 1}">下一页</a>` : ''}
    </nav>
  </body>
</html>`
}

/** 路径分页列表：/page/1、/page/2。 */
function pathPage(page) {
  return `${PAGE_HEAD(`路径分页 第 ${page} 页`)}
  <body>
    <ul class="list">
      <li class="item"><a href="/article/${page * 2 - 1}">第 ${page} 页第一篇</a></li>
      <li class="item"><a href="/article/${page * 2}">第 ${page} 页第二篇</a></li>
    </ul>
    ${page === 1 ? '<a class="next" href="/page/2">下一页</a>' : ''}
  </body>
</html>`
}

function detailPage(article) {
  const paragraphs = article.paragraphs.map((text) => `      <p>${text}</p>`).join('\n')
  return `${PAGE_HEAD(article.title)}
  <body>
    <script>window.__fixture_article_script = true</script>
    <article>
      <h1 class="article-title">${article.title}</h1>
      <div class="meta">
        <span class="author">${article.author}</span>
        <span class="publish-time">${article.time}</span>
      </div>
      <div class="article-content">
${paragraphs}
        <img class="body-image" src="/images/${article.id}.png" alt="配图" />
        <div class="ad">广告位：不应出现在正文里</div>
      </div>
    </article>
    <footer><a href="/">返回首页</a></footer>
  </body>
</html>`
}

/** SPA 页面：DOM 由脚本渲染，只有浏览器模式能看到内容。 */
function spaPage() {
  return `${PAGE_HEAD('SPA 列表 - Fixture 站点')}
  <body>
    <div id="app">加载中…</div>
    <script>
      // 同步渲染：浏览器模式在 load 之后即可拿到内容；HTTP 模式只看到「加载中…」
      document.getElementById('app').innerHTML =
        '<div class="spa-item"><a class="spa-link" href="/article/1">SPA 第一篇</a></div>' +
        '<div class="spa-item"><a class="spa-link" href="/article/2">SPA 第二篇</a></div>'
    </script>
  </body>
</html>`
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2wAAAABJRU5ErkJggg==',
  'base64',
)

/** 创建 fixture HTTP 服务（不自动监听，调用方决定端口）。 */
export function createFixtureServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }

    if (path === '/') {
      html(`${PAGE_HEAD('Fixture 首页')}<body><h1>Fixture 站点</h1><a href="/news">新闻列表</a></body></html>`)
      return
    }
    if (path === '/news') {
      html(listPage())
      return
    }
    if (path === '/paged') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
      html(pagedPage(page))
      return
    }
    if (path.startsWith('/page/')) {
      const page = Math.max(1, Number(path.slice('/page/'.length)) || 1)
      html(pathPage(page))
      return
    }
    if (path === '/spa') {
      html(spaPage())
      return
    }
    if (path.startsWith('/article/')) {
      const id = Number(path.slice('/article/'.length))
      const article = ARTICLES.find((item) => item.id === id)
      if (article) {
        html(detailPage(article))
        return
      }
    }
    if (path.startsWith('/images/')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(ONE_PIXEL_PNG)
      return
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`${PAGE_HEAD('404')}<body><h1>404 Not Found</h1></body></html>`)
  })
}

/** 供测试使用：监听随机端口并返回 origin 与关闭函数。 */
export async function startFixture(options = {}) {
  const server = createFixtureServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    server,
    origin: `http://${options.host ?? '127.0.0.1'}:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = Number(process.env.FIXTURE_PORT ?? 4100)
  startFixture({ port }).then(({ origin }) => {
    console.log(`fixture listening on ${origin}`)
    console.log(`  列表页    ${origin}/news`)
    console.log(`  分页列表  ${origin}/paged?page=1`)
    console.log(`  路径分页  ${origin}/page/1`)
    console.log(`  详情页    ${origin}/article/1`)
    console.log(`  SPA 页面  ${origin}/spa`)
  })
}
