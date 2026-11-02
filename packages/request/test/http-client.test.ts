import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utils } from 'request-pack'
import {
  RequestError,
  RequestErrorCode,
  createRequestClient,
  type RequestClient,
} from '../src/index.js'
import { startFixtureServer, startProxyServer, type FixtureServer, type ProxyFixture } from './helpers/server.js'

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>测试页</title></head>
<body><h1>标题</h1><p>正文内容</p></body></html>`
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

let server: FixtureServer
let client: RequestClient
let flakyHits = 0
let postHits = 0

beforeAll(async () => {
  server = await startFixtureServer({
    '/html': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HTML)
    },
    '/gbk': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=gbk' })
      res.end(utils.iconv.encode('<html><head><title>中文标题</title></head><body>中文内容</body></html>', 'gbk'))
    },
    '/json': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }))
    },
    '/binary': (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    },
    '/slow': () => {
      // 故意不响应，用于超时与取消
    },
    '/big': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('x'.repeat(300 * 1024))
    },
    '/redirect': (_req, res) => {
      res.writeHead(302, { location: '/redirect-2' })
      res.end()
    },
    '/redirect-2': (_req, res) => {
      res.writeHead(301, { location: '/html' })
      res.end()
    },
    '/redirect-loop': (_req, res) => {
      res.writeHead(302, { location: '/redirect-loop' })
      res.end()
    },
    '/echo': (req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ method: req.method, body, contentType: req.headers['content-type'] ?? null }))
    },
    '/flaky': (_req, res) => {
      flakyHits += 1
      if (flakyHits === 1) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ok')
    },
    '/post-flaky': (_req, res) => {
      postHits += 1
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    },
    '/set-cookie': (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
      })
      res.end('cookies')
    },
  })

  client = createRequestClient({ ssrf: { allowPrivateNetwork: true } })
})

afterAll(async () => {
  client.close()
  await server.close()
})

describe('HttpClient 基础能力', () => {
  it('GET 返回 HTML 文本、状态码、响应头与耗时', async () => {
    const response = await client.get(`${server.origin}/html`, { query: { from: 'test', tags: ['a', 'b'] } })

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.text).toContain('<h1>标题</h1>')
    expect(response.charset).toBe('utf-8')
    expect(response.contentType).toContain('text/html')
    expect(response.isText).toBe(true)
    expect(response.finalUrl).toContain('from=test')
    expect(response.finalUrl).toContain('tags=a')
    expect(response.elapsedMs).toBeGreaterThan(0)
    expect(response.redirects).toEqual([])
    expect(response.timings.hopsMs).toHaveLength(1)
  })

  it('按 header 声明的 GBK 编码正确解码', async () => {
    const response = await client.get(`${server.origin}/gbk`)
    expect(response.charset).toBe('gbk')
    expect(response.text).toContain('中文标题')
    expect(response.text).toContain('中文内容')
  })

  it('JSON 响应可直接解析', async () => {
    const data = await client.getJson<{ ok: boolean; items: number[] }>(`${server.origin}/json`)
    expect(data).toEqual({ ok: true, items: [1, 2, 3] })
  })

  it('二进制响应保留原始字节，不被强制转成 HTML', async () => {
    const response = await client.get(`${server.origin}/binary`)
    expect(response.isText).toBe(false)
    expect(response.text).toBe('')
    expect(Buffer.compare(response.body, PNG)).toBe(0)
  })

  it('POST 以 JSON 发送对象请求体', async () => {
    const response = await client.post(`${server.origin}/echo`, { title: '标题', count: 2 })
    const data = response.json<{ method: string; body: string; contentType: string }>()

    expect(data.method).toBe('POST')
    expect(JSON.parse(data.body)).toEqual({ title: '标题', count: 2 })
    expect(data.contentType).toContain('application/json')
  })

  it('Cookie 配置会拼进请求头，并返回 set-cookie', async () => {
    const response = await client.get(`${server.origin}/set-cookie`, { cookies: { session: 'abc' } })
    expect(response.setCookies).toHaveLength(2)

    const sent = server.requests.at(-1)
    expect(sent?.headers.cookie).toBe('session=abc')
  })

  it('自定义 User-Agent 生效', async () => {
    await client.get(`${server.origin}/html`, { userAgent: 'WebCrawlerTest/2.0' })
    expect(server.requests.at(-1)?.headers['user-agent']).toBe('WebCrawlerTest/2.0')
  })
})

describe('HttpClient 重定向', () => {
  it('跟随多级重定向并记录每一跳', async () => {
    const response = await client.get(`${server.origin}/redirect`)

    expect(response.status).toBe(200)
    expect(response.finalUrl).toBe(`${server.origin}/html`)
    expect(response.redirects).toEqual([`${server.origin}/redirect-2`, `${server.origin}/html`])
    expect(response.timings.hopsMs).toHaveLength(3)
  })

  it('超过重定向上限时报错', async () => {
    await expect(client.get(`${server.origin}/redirect-loop`, { maxRedirects: 2 })).rejects.toMatchObject({
      code: RequestErrorCode.TOO_MANY_REDIRECTS,
    })
  })
})

describe('HttpClient 超时、取消与大小限制', () => {
  it('超时抛出 TIMEOUT', async () => {
    const error = await client.get(`${server.origin}/slow`, { timeoutMs: 120 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RequestError)
    expect((error as RequestError).code).toBe(RequestErrorCode.TIMEOUT)
  })

  it('AbortSignal 取消抛出 ABORTED', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    const error = await client
      .get(`${server.origin}/slow`, { signal: controller.signal, timeoutMs: 5000 })
      .catch((e: unknown) => e)

    expect((error as RequestError).code).toBe(RequestErrorCode.ABORTED)
  })

  it('响应体超过上限时中断并报错', async () => {
    const error = await client.get(`${server.origin}/big`, { maxBytes: 1024 }).catch((e: unknown) => e)
    expect((error as RequestError).code).toBe(RequestErrorCode.RESPONSE_TOO_LARGE)
  })
})

describe('HttpClient 重试策略', () => {
  it('GET 遇到 5xx 会重试，且需要显式开启', async () => {
    const response = await client.get(`${server.origin}/flaky`, { retries: 1, retryDelayMs: 10 })
    expect(response.status).toBe(200)
    expect(response.text).toBe('ok')
    expect(flakyHits).toBe(2)
  })

  it('POST 即使配置了重试也不会自动重发', async () => {
    const response = await client.post(`${server.origin}/post-flaky`, { a: 1 }, { retries: 3, retryDelayMs: 1 })
    expect(response.status).toBe(500)
    expect(postHits).toBe(1)
  })

  it('throwOnHttpError 时把错误状态码转成异常', async () => {
    const error = await client
      .get(`${server.origin}/404-not-exist`, { throwOnHttpError: true })
      .catch((e: unknown) => e)

    expect((error as RequestError).code).toBe(RequestErrorCode.HTTP_STATUS)
    expect((error as RequestError).status).toBe(404)
    expect((error as RequestError).retryable).toBe(false)
  })
})

describe('HttpClient 代理', () => {
  let proxy: ProxyFixture

  beforeAll(async () => {
    proxy = await startProxyServer()
  })

  afterAll(async () => {
    await proxy.close()
  })

  it('通过 HTTP 代理转发请求', async () => {
    const proxied = createRequestClient({ ssrf: { allowPrivateNetwork: true } })
    try {
      const response = await proxied.get(`${server.origin}/html`, {
        proxy: { protocol: 'http', host: '127.0.0.1', port: proxy.port },
      })
      expect(response.status).toBe(200)
      expect(response.text).toContain('测试页')
      expect(proxy.seen.some((url) => url.includes('/html'))).toBe(true)
    } finally {
      proxied.close()
    }
  })

  it('代理认证失败时返回 PROXY_ERROR，而不是当成普通响应', async () => {
    const authProxy = await startProxyServer(`Basic ${Buffer.from('user:secret').toString('base64')}`)
    const proxied = createRequestClient({ ssrf: { allowPrivateNetwork: true } })
    try {
      const error = await proxied
        .get(`${server.origin}/html`, {
          proxy: { protocol: 'http', host: '127.0.0.1', port: authProxy.port },
        })
        .catch((e: unknown) => e)

      expect((error as RequestError).code).toBe(RequestErrorCode.PROXY_ERROR)
    } finally {
      proxied.close()
      await authProxy.close()
    }
  })

  it('代理用户名密码会带上 Proxy-Authorization', async () => {
    const authProxy = await startProxyServer(`Basic ${Buffer.from('user:secret').toString('base64')}`)
    const proxied = createRequestClient({ ssrf: { allowPrivateNetwork: true } })
    try {
      const response = await proxied.get(`${server.origin}/html`, {
        proxy: { protocol: 'http', host: '127.0.0.1', port: authProxy.port, username: 'user', password: 'secret' },
      })
      expect(response.status).toBe(200)
    } finally {
      proxied.close()
      await authProxy.close()
    }
  })
})
