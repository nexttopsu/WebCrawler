import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RequestErrorCode, createBrowserClient, type BrowserClient } from '../src/index.js'
import { startFixtureServer, type FixtureServer } from './helpers/server.js'

const SPA_HTML = `<!doctype html><html><head><title>初始标题</title></head>
<body>
  <div id="app">服务端占位</div>
  <script>
    document.getElementById('app').innerHTML = '<h1 class="title">渲染完成</h1><p class="body">脚本生成的正文</p>';
    document.title = '渲染后的标题';
  </script>
</body></html>`

let server: FixtureServer
let client: BrowserClient

beforeAll(async () => {
  server = await startFixtureServer({
    '/spa': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SPA_HTML)
    },
    '/plain': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>普通页</title></head><body><p>静态内容</p></body></html>')
    },
    '/redirect': (_req, res) => {
      res.writeHead(302, { location: '/spa' })
      res.end()
    },
    '/slow': () => {
      // 不响应
    },
  })

  client = createBrowserClient({
    maxPages: 2,
    timeoutMs: 15_000,
    ssrf: { allowPrivateNetwork: true },
  })
}, 60_000)

afterAll(async () => {
  await client.close()
  await server.close()
})

describe('BrowserClient', () => {
  it('渲染 SPA 后返回最终 DOM 与标题', async () => {
    const page = await client.fetchPage({ url: `${server.origin}/spa`, waitUntil: 'load' })

    expect(page.status).toBe(200)
    expect(page.title).toBe('渲染后的标题')
    expect(page.html).toContain('渲染完成')
    expect(page.html).toContain('脚本生成的正文')
    expect(page.html).not.toContain('服务端占位')
    expect(page.finalUrl).toBe(`${server.origin}/spa`)
    expect(page.elapsedMs).toBeGreaterThan(0)
  })

  it('支持等待指定选择器', async () => {
    const page = await client.fetchPage({ url: `${server.origin}/spa`, waitForSelector: '.title' })
    expect(page.html).toContain('渲染完成')
  })

  it('可以截图', async () => {
    const page = await client.fetchPage({ url: `${server.origin}/plain`, screenshot: true })
    expect(page.screenshot).toBeInstanceOf(Buffer)
    // PNG 魔数
    expect(page.screenshot?.subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('返回重定向后的最终地址', async () => {
    const page = await client.fetchPage({ url: `${server.origin}/redirect` })
    expect(page.finalUrl).toBe(`${server.origin}/spa`)
  })

  it('默认 SSRF 策略会拦截内网地址', async () => {
    const strict = createBrowserClient({ timeoutMs: 5000 })
    try {
      const error = await strict.fetchPage({ url: `${server.origin}/plain` }).catch((e: unknown) => e)
      expect(error).toMatchObject({ code: RequestErrorCode.BLOCKED_URL })
    } finally {
      await strict.close()
    }
  })

  it('页面加载超时抛出 TIMEOUT', async () => {
    const error = await client
      .fetchPage({ url: `${server.origin}/slow`, timeoutMs: 1500 })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: RequestErrorCode.TIMEOUT })
  }, 30_000)

  it('并发页面受 maxPages 限制且互不串扰', async () => {
    const results = await Promise.all([
      client.fetchPage({ url: `${server.origin}/spa` }),
      client.fetchPage({ url: `${server.origin}/plain` }),
      client.fetchPage({ url: `${server.origin}/spa` }),
    ])
    expect(results.map((item) => item.title)).toEqual(['渲染后的标题', '普通页', '渲染后的标题'])
  }, 30_000)
})
