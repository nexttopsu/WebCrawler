'use strict'

/**
 * WebCrawler Electron 主进程。
 *
 * 职责：
 * 1. 以 ELECTRON_RUN_AS_NODE 启动后端服务（同一份 server/dist）；
 * 2. 在本进程内开一个静态/反代服务：界面走本地静态文件，/api 与 /resources 透传给后端；
 * 3. 打开 BrowserWindow 显示界面；退出时一并关掉后端与 HTTP 服务。
 *
 * 后端源码零改动：这里不修改服务端路由，也不用它托管前端。
 */
const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const API_PORT = Number(process.env.WEBCRAWLER_API_PORT || 3000)
const UI_PORT = Number(process.env.WEBCRAWLER_UI_PORT || 3001)
const HOST = '127.0.0.1'

/** 打包时禁用 asar；同时兼容 asar 解包布局，便于开发调试。 */
const plainRoot = path.join(process.resourcesPath, 'app')
const unpackedRoot = path.join(process.resourcesPath, 'app.asar.unpacked')
const appRoot = fs.existsSync(plainRoot)
  ? plainRoot
  : fs.existsSync(unpackedRoot)
    ? unpackedRoot
    : path.join(process.resourcesPath, 'app.asar')
const serverEntry = path.join(appRoot, 'app', 'server', 'dist', 'server', 'index.js')
const webRoot = path.join(appRoot, 'app', 'web', 'dist')
const resourcesDir = path.join(appRoot, 'app', 'resources')
// 绿色版：数据放在 exe 同级 data/，卸载/转移目录时数据跟着走
const dataDir = path.join(path.dirname(app.getPath('exe')), 'data')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

let backend = null
let uiServer = null
let mainWindow = null

function fail(message) {
  dialog.showErrorBox('WebCrawler 启动失败', message)
  app.quit()
}

function startBackend() {
  if (!fs.existsSync(serverEntry)) {
    fail(`找不到后端入口：\n${serverEntry}`)
    return false
  }

  const env = {
    ...process.env,
    // 让 Electron 可执行文件以普通 Node 运行时启动后端
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    NODE_NO_WARNINGS: '1',
    HOST,
    PORT: String(API_PORT),
    DATABASE_FILE: path.join(dataDir, 'webcrawler.db'),
    DEBUG_DATABASE_FILE: path.join(dataDir, 'debug.db'),
    DEBUG_CAPTURE_PROFILE_DIR: path.join(dataDir, 'capture-profile'),
    RESOURCES_DIR: resourcesDir,
    ALLOW_PRIVATE_NETWORK: 'false',
  }

  backend = spawn(process.execPath, [serverEntry], {
    cwd: path.join(appRoot, 'app', 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  backend.stdout.on('data', (chunk) => process.stdout.write(`[api] ${chunk}`))
  backend.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`))
  backend.on('exit', (code) => {
    backend = null
    if (code && code !== 0) {
      dialog.showErrorBox('WebCrawler 后端已退出', `退出码：${code}`)
      app.quit()
    }
  })
  return true
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

async function waitForApi() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!backend) return false
    if (await canConnect(API_PORT)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ success: false, error: { message: '页面不存在' } }))
}

function proxyToBackend(req, res) {
  const upstream = http.request(
    {
      hostname: HOST,
      port: API_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${HOST}:${API_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: false, error: { message: '后端服务不可用' } }))
  })
  req.pipe(upstream)
}

async function serveWebUi(req, res, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return notFound(res)
  }
  if (decoded.includes('\0')) return notFound(res)

  const target = path.resolve(webRoot, `.${decoded}`)
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) return notFound(res)

  let filePath = target
  try {
    const info = await fsp.stat(target)
    if (!info.isFile()) filePath = null
  } catch {
    filePath = null
  }

  // 无扩展名的前端路由回退到 index.html；缺失的静态资源直接 404
  if (!filePath && !path.extname(decoded)) {
    const indexFile = path.join(webRoot, 'index.html')
    try {
      const info = await fsp.stat(indexFile)
      if (info.isFile()) filePath = indexFile
    } catch {
      // ignore
    }
  }
  if (!filePath) return notFound(res)

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(filePath).pipe(res)
}

function startUiServer() {
  uiServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://${HOST}:${UI_PORT}`).pathname
    if (pathname.startsWith('/api/') || pathname.startsWith('/resources/')) {
      return proxyToBackend(req, res)
    }
    void serveWebUi(req, res, pathname)
  })
  uiServer.on('error', (error) => fail(`本地界面服务启动失败：${error.message}`))
  uiServer.listen(UI_PORT, HOST)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: 'WebCrawler',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  mainWindow.loadURL(`http://${HOST}:${UI_PORT}/`)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  if (!fs.existsSync(webRoot)) {
    fail(`找不到前端产物：\n${webRoot}`)
    return
  }
  if (!startBackend()) return
  if (!(await waitForApi())) {
    fail('后端服务启动超时，请查看控制台日志。')
    return
  }
  startUiServer()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (backend && !backend.killed) backend.kill('SIGTERM')
  if (uiServer) uiServer.close()
})
