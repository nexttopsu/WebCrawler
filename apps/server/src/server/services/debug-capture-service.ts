import { mkdirSync } from 'node:fs'
import { chromium, type BrowserContext, type Response as PlaywrightResponse } from 'playwright'
import { detectCharset, utils } from 'request-pack'
import { z } from 'zod'
import type {
  DebugCaptureItemDto,
  DebugCaptureStartInput,
  DebugCaptureState,
  DebugCaptureStatusDto,
} from '../../shared/index.js'
import { isBrowserMissingError } from '../../request/browser-client.js'
import type { AppConfig } from '../config.js'
import { ConfigurationError, ConflictError } from '../errors.js'
import { RAW_MAX_BYTES, saveCapturedSample } from './debug-data-service.js'

/**
 * 捕获浏览器。
 *
 * 从「调试数据」页启动一个有头 Chromium，用户在窗口里正常浏览，
 * 浏览过程中每个网页（主文档）的响应原文都会被写进调试库 ——
 * 之后采集 / 测试这些网址时会直接命中存档，不再访问目标站点。
 *
 * 几个刻意的设计：
 * - **持久化用户目录**（`data/capture-profile`）：登录态、Cookie 跨会话保留，
 *   才能抓到需要登录的页面；删掉这个目录即可回到干净的浏览器。
 * - **覆盖而不是报冲突**：同一个网址再访问一次就更新 raw，保留备注、启停与命中统计。
 * - **只记主文档 + 可选 JSON**：iframe / 图片 / 字体不入库，避免一条页面带出几十条噪音。
 * - **只记 200 / 304**：只有这两个状态码才有可解析的正文；4xx / 5xx 的错误页、
 *   3xx 跳转的空响应都不入库，避免调试库里混进一堆没法用的样本。
 * - **不做 SSRF 限制**：这是管理员手动操作的浏览器（等同在服务器上开浏览器），
 *   需要能访问内网 / 本机页面；它不参与采集任务的请求链路。
 * - **单例**：同一时刻只允许一个捕获浏览器，再次启动返回 409。
 */

/** 单次会话最多写入的条数，防止在电商站来回点把库点爆。 */
const MAX_CAPTURES_PER_SESSION = 1000

/** 同时读取响应体的并发数（读取会等待响应完成，过高会拖慢浏览器）。 */
const CAPTURE_CONCURRENCY = 3

/** 只记录这些 content-type 的文档；其余（PDF / 图片 / 二进制）直接跳过。 */
const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml|text\/xml|application\/xml)/i

/**
 * 只记录「确实有数据可解析」的状态码：
 * - 200：正常返回；
 * - 304：协商缓存命中，正文由浏览器缓存提供 —— 浏览器里页面照常显示，
 *   调试库也应存到内容，否则这类页面会漏记。
 * 其余（3xx 跳转、4xx、5xx、206 分片）一律不入库。
 */
const CAPTURABLE_STATUS = new Set([200, 304])

/** 状态码是否入库（导出给测试用，避免为了验证一行判断去拉起真实浏览器）。 */
export function isCapturableStatus(status: number): boolean {
  return CAPTURABLE_STATUS.has(status)
}

/** 自动写入的备注，用户可以在列表里改成自己的说明（覆盖时不会冲掉）。 */
const CAPTURE_NOTE = '浏览器捕获'

/** 单条 URL 上限，与手工新增的校验保持一致。 */
const URL_MAX_LENGTH = 2048

/** 启动入参校验：所有字段可选，空体等价于「打开空白页、有头、只记网页」。 */
export const debugCaptureStartSchema = z
  .object({
    startUrl: z
      .string()
      .trim()
      .max(URL_MAX_LENGTH, `起始网址不能超过 ${URL_MAX_LENGTH} 个字符`)
      .refine(
        (value) => value === '' || /^https?:\/\//i.test(value),
        '起始网址必须是 http(s) 绝对地址',
      )
      .nullish(),
    includeJson: z.boolean().default(false),
    headless: z.boolean().default(false),
  })
  .strict()

interface CaptureSession {
  context: BrowserContext
  state: DebugCaptureState
  startedAt: string
  stoppedAt: string | null
  startUrl: string | null
  headless: boolean
  includeJson: boolean
  captured: number
  created: number
  updated: number
  skipped: number
  failed: number
  lastUrl: string | null
  lastError: string | null
  recent: DebugCaptureItemDto[]
  /** 关闭流程已经开始：不再接受新的响应 */
  closing: boolean
}

function idleStatus(): DebugCaptureStatusDto {
  return {
    state: 'idle',
    startedAt: null,
    stoppedAt: null,
    startUrl: null,
    headless: false,
    includeJson: false,
    captured: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    lastUrl: null,
    lastError: null,
    recent: [],
  }
}

let session: CaptureSession | null = null
/** 上一次会话的收尾统计：停止后页面仍能看到「刚记录了 N 个页面」。 */
let lastStatus: DebugCaptureStatusDto = idleStatus()
/** 启动是异步的（约 1s），用这个标记挡住并发点击。 */
let starting = false
/** 进行中的响应体读取，停止时等它们收尾。 */
const inflight = new Set<Promise<void>>()

function toStatus(current: CaptureSession): DebugCaptureStatusDto {
  return {
    state: current.state,
    startedAt: current.startedAt,
    stoppedAt: current.stoppedAt,
    startUrl: current.startUrl,
    headless: current.headless,
    includeJson: current.includeJson,
    captured: current.captured,
    created: current.created,
    updated: current.updated,
    skipped: current.skipped,
    failed: current.failed,
    lastUrl: current.lastUrl,
    lastError: current.lastError,
    recent: current.recent.slice(),
  }
}

/** 当前状态；没有会话时返回上一次会话的统计（或初始 idle）。 */
export function getDebugCaptureStatus(): DebugCaptureStatusDto {
  return session ? toStatus(session) : { ...lastStatus, recent: lastStatus.recent.slice() }
}

/** 简化的并发队列：读取响应体这种 IO 任务不需要更复杂的调度。 */
class CaptureQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run(task: () => Promise<void>): Promise<void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    try {
      await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

const queue = new CaptureQueue(CAPTURE_CONCURRENCY)

function profileDirectory(config: AppConfig): string {
  return config.debugCaptureProfileDir
}

/**
 * 启动捕获浏览器。
 *
 * 已有会话时返回 409（不静默替换用户的浏览窗口）。
 * 启动失败（内核未安装 / 无图形会话）抛 503，并把原因写进 message。
 */
export async function startDebugCapture(
  config: AppConfig,
  input: DebugCaptureStartInput,
): Promise<DebugCaptureStatusDto> {
  if (session || starting) {
    throw new ConflictError('捕获浏览器已在运行，请先停止再重新启动')
  }

  const startUrl = input.startUrl?.trim() || null
  starting = true

  let context: BrowserContext
  try {
    const directory = profileDirectory(config)
    mkdirSync(directory, { recursive: true })
    context = await chromium.launchPersistentContext(directory, {
      headless: input.headless ?? false,
      viewport: { width: 1440, height: 900 },
      // 关闭「请勿关闭浏览器」提示条：它会让自动化启动的窗口比普通窗口多一条横幅
      args: ['--hide-crash-restore-bubble'],
      acceptDownloads: false,
    })
  } catch (error) {
    starting = false
    const raw = error instanceof Error ? error.message : String(error)
    const message = isBrowserMissingError(error)
      ? '浏览器内核未安装：请先执行 npx playwright install chromium'
      : `浏览器启动失败：${raw}`
    throw new ConfigurationError(message, { reason: raw })
  }

  const current: CaptureSession = {
    context,
    state: 'running',
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    startUrl,
    headless: input.headless ?? false,
    includeJson: input.includeJson ?? false,
    captured: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    lastUrl: null,
    lastError: null,
    recent: [],
    closing: false,
  }
  session = current
  starting = false

  context.on('response', (response) => {
    if (session !== current || current.closing) return
    captureResponse(current, response)
  })

  // 用户直接关掉浏览器窗口时同步状态，避免界面一直显示「运行中」
  context.on('close', () => {
    if (session !== current) return
    current.closing = true
    current.state = 'stopped'
    current.stoppedAt = new Date().toISOString()
    lastStatus = toStatus(current)
    session = null
  })

  // 起始页不阻塞启动响应：慢站点（30s 超时）会把 HTTP 请求拖到前端超时，
  // 而浏览器其实已经开好了。打开结果通过状态接口的 lastError 反馈。
  if (startUrl) void openStartUrl(current, startUrl)

  return toStatus(current)
}

/** 打开起始网址；失败只记录到 lastError，不影响会话继续使用。 */
async function openStartUrl(current: CaptureSession, startUrl: string): Promise<void> {
  try {
    const page = current.context.pages()[0] ?? (await current.context.newPage())
    await page.bringToFront()
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (error) {
    current.lastError = `起始网址打开失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 停止捕获浏览器并返回本次会话的统计。
 *
 * 幂等：没有会话时直接返回当前状态，不会报错。
 */
export async function stopDebugCapture(): Promise<DebugCaptureStatusDto> {
  const current = session
  if (!current) return getDebugCaptureStatus()

  current.closing = true
  current.state = 'stopped'
  current.stoppedAt = new Date().toISOString()

  // 给正在读取的响应体最多 2s 收尾，避免刚点停止就丢掉最后一页
  await Promise.race([
    Promise.allSettled([...inflight]),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])

  session = null
  lastStatus = toStatus(current)
  try {
    await current.context.close()
  } catch {
    // 用户已经关掉窗口时忽略
  }
  return getDebugCaptureStatus()
}

/** 进程退出时清理浏览器进程（由停机流程调用）。 */
export async function closeDebugCapture(): Promise<void> {
  if (!session) return
  try {
    await stopDebugCapture()
  } catch {
    session = null
  }
}

/* -------------------------------------------------------------------------- */
/* 响应 → 调试库                                                               */
/* -------------------------------------------------------------------------- */

function isMainFrame(response: PlaywrightResponse): boolean {
  try {
    return response.frame().parentFrame() === null
  } catch {
    return false
  }
}

function shouldCapture(current: CaptureSession, response: PlaywrightResponse): boolean {
  const url = response.url()
  if (!/^https?:\/\//i.test(url)) return false
  if (url.length > URL_MAX_LENGTH) return false
  if (!isMainFrame(response)) return false

  // 只留 200 / 304：3xx 跳转没有正文（跳转后的文档会单独记录），
  // 4xx / 5xx 拿到的多是错误页，存下来只会污染调试数据。
  if (!isCapturableStatus(response.status())) return false

  const type = response.request().resourceType()
  if (type === 'document') {
    const contentType = response.headers()['content-type'] ?? ''
    // 没有 content-type 时仍按网页处理：有些老站点确实不返回这个头
    if (!contentType || HTML_CONTENT_TYPE.test(contentType)) return true
    // 直接在地址栏打开一个 JSON 接口时，开了「记录接口」也收下
    return current.includeJson && /json/i.test(contentType)
  }
  if (current.includeJson && (type === 'xhr' || type === 'fetch')) {
    return /json/i.test(response.headers()['content-type'] ?? '')
  }
  return false
}

function captureResponse(current: CaptureSession, response: PlaywrightResponse): void {
  if (!shouldCapture(current, response)) return
  if (current.captured >= MAX_CAPTURES_PER_SESSION) {
    current.skipped += 1
    current.lastError = `本次会话已达到 ${MAX_CAPTURES_PER_SESSION} 条上限，后续页面不再记录`
    return
  }

  const task = queue
    .run(async () => {
      try {
        const raw = await readBody(response)
        if (raw === null) {
          current.skipped += 1
          return
        }
        if (session !== current) return

        const contentType = /json/i.test(response.headers()['content-type'] ?? '') ? 'json' : 'html'
        const saved = saveCapturedSample({
          url: response.url(),
          raw,
          statusCode: response.status(),
          contentType,
          note: CAPTURE_NOTE,
        })

        current.captured += 1
        if (saved.created) current.created += 1
        else current.updated += 1
        current.lastUrl = response.url()
        current.recent.unshift({
          sampleId: saved.id,
          url: response.url(),
          contentType,
          statusCode: response.status(),
          rawSize: saved.rawSize,
          isNew: saved.created,
          capturedAt: new Date().toISOString(),
        })
        if (current.recent.length > 20) current.recent.length = 20
      } catch (error) {
        current.failed += 1
        current.lastError = `读取响应失败：${error instanceof Error ? error.message : String(error)}`
      }
    })
    .catch(() => undefined)

  inflight.add(task)
  void task.finally(() => inflight.delete(task))
}

/**
 * 读出响应体并解码成文本。
 *
 * - 超过 20 MB（与手工新增同一上限）返回 null，计入 skipped；
 * - 空响应体（204 / 预检）返回 null；
 * - 编码用 request-pack 的 `detectCharset`：GBK 站点不会因为浏览器内核
 *   返回 UTF-8 字节而变成乱码。
 */
async function readBody(response: PlaywrightResponse): Promise<string | null> {
  // 304 的正文在浏览器缓存里，DevTools 协议有时直接报「No resource with given
  // identifier」；body 取不到不是错误，交给下面的 DOM 兜底。
  const buffer = await response.body().catch(() => null)
  if (buffer && buffer.byteLength > 0 && buffer.byteLength <= RAW_MAX_BYTES) {
    const headers = response.headers()
    const contentType = headers['content-type'] ?? ''
    const charset = /json/i.test(contentType)
      ? 'utf-8'
      : (detectCharset(headers, buffer) ?? 'utf-8')
    try {
      return utils.decode(buffer, charset)
    } catch {
      return buffer.toString('utf8')
    }
  }

  if (response.status() === 304) return readRenderedHtml(response)
  return null
}

/**
 * 304 的兜底：直接用浏览器已渲染的 DOM 序列化结果。
 *
 * 缓存命中的页面在窗口里是完整可见的，而协议层拿不到原始字节；
 * 序列化 HTML 已经是浏览器归一化后的结果（属性顺序、实体等可能变化），
 * 但对「按网址存档、供解析规则复用」这个用途足够，且比丢掉整页更有价值。
 * JSON 之类非文档响应没有 DOM，直接跳过。
 */
async function readRenderedHtml(response: PlaywrightResponse): Promise<string | null> {
  if (response.request().resourceType() !== 'document') return null
  try {
    const html = await response.frame().content()
    if (!html || Buffer.byteLength(html, 'utf8') > RAW_MAX_BYTES) return null
    return html
  } catch {
    return null
  }
}
