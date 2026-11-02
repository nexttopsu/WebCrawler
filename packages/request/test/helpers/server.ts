/**
 * 测试用本地站点与代理。
 *
 * 覆盖请求层需要的能力：HTML / JSON / 二进制 / 重定向 / 编码 / 超时 / 大响应 / HTTP 代理。
 * 测试不依赖任何第三方网站。
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface FixtureServer {
  /** 形如 http://127.0.0.1:PORT */
  origin: string
  port: number
  requests: FixtureRequest[]
  close(): Promise<void>
}

/** 启动一个本地站点，路由按路径匹配。 */
export async function startFixtureServer(
  routes: Record<string, (req: IncomingMessage, res: ServerResponse, body: string) => void>,
): Promise<FixtureServer> {
  const requests: FixtureRequest[] = []

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body })

      const path = (req.url ?? '/').split('?')[0] ?? '/'
      const handler = routes[path]
      if (handler) {
        handler(req, res, body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export interface ProxyFixture extends FixtureServer {
  /** 代理实际转发过的目标地址 */
  seen: string[]
}

/** 简易正向代理：只处理 http 明文请求（绝对 URI 形式），并校验可选的 Proxy-Authorization。 */
export async function startProxyServer(expectedAuth?: string): Promise<ProxyFixture> {
  const seen: string[] = []

  const server = createServer((req, res) => {
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' })
      res.end('proxy auth required')
      return
    }

    if (!req.url || !/^https?:\/\//i.test(req.url)) {
      res.writeHead(400)
      res.end('proxy expects absolute uri')
      return
    }

    seen.push(req.url)
    const target = new URL(req.url)
    const proxyReq = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on('error', () => {
      res.writeHead(502)
      res.end('upstream error')
    })
    req.pipe(proxyReq)
  })

  server.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url ?? ''}`)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests: [],
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
