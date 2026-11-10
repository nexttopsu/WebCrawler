/**
 * 调试数据契约。
 *
 * 调试数据是「按网址存档的响应原文」：采集任务与规则测试器在发请求之前先查这里，
 * **网址完全相等**时直接拿存档的 raw，不再访问目标站点。
 * 它存在独立的 SQLite 库（`data/debug.db`）里，和业务库分开，随时可以整库删掉重建。
 *
 * 列表接口刻意不返回 raw（可能几百 KB），只返回大小；编辑时单独取详情。
 */

/** 存档原文的类型：json 时管道按 JSON 解析，其余按 HTML。 */
export type DebugContentType = 'html' | 'json'

/** 调试数据列表项（不含 raw）。 */
export interface DebugSampleDto {
  id: number
  /** 精确匹配键：采集 / 测试时的完整网址 */
  url: string
  /** 命中后返回给采集流程的状态码 */
  statusCode: number
  contentType: DebugContentType
  /** 备注，便于说明这条数据是怎么来的 */
  note: string | null
  /** 停用后不参与匹配，但数据保留 */
  enabled: boolean
  /** 原文长度（字节），列表里代替 raw 展示 */
  rawSize: number
  /** 被采集 / 测试命中的次数 */
  hitCount: number
  /** 最近一次命中的时间（ISO 8601） */
  lastHitAt: string | null
  createdAt: string
  updatedAt: string
}

/** 调试数据详情（含 raw），只在查看 / 编辑单个条目时返回。 */
export interface DebugSampleDetailDto extends DebugSampleDto {
  raw: string
}

/** 新增 / 编辑调试数据的入参。 */
export interface DebugSampleInput {
  url: string
  raw: string
  statusCode?: number
  contentType?: DebugContentType
  note?: string | null
  enabled?: boolean
}

/** 调试数据列表的筛选条件（服务端 Schema 的对外形态）。 */
export interface DebugSampleQuery {
  keyword?: string
  contentType?: DebugContentType
  enabled?: boolean
}

/* -------------------------------------------------------------------------- */
/* 捕获浏览器                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 捕获浏览器状态。
 *
 * `running` 时后端有一个可见的 Chromium 进程，它访问的每个网页（document）
 * 都会被写进调试库；`stopped` 是上一次会话的收尾统计，页面刷新后仍能看到。
 */
export type DebugCaptureState = 'idle' | 'running' | 'stopped' | 'error'

/** 捕获到的单条记录，用于状态接口里的「最近捕获」列表。 */
export interface DebugCaptureItemDto {
  /** 写入 / 更新后的调试数据 id */
  sampleId: number
  url: string
  contentType: DebugContentType
  statusCode: number
  rawSize: number
  /** true = 新建；false = 该网址已有记录，本次覆盖了 raw */
  isNew: boolean
  capturedAt: string
}

/** 捕获浏览器状态（前端 2s 轮询）。 */
export interface DebugCaptureStatusDto {
  state: DebugCaptureState
  startedAt: string | null
  stoppedAt: string | null
  startUrl: string | null
  headless: boolean
  /** 是否同时记录 XHR / Fetch 返回的 JSON */
  includeJson: boolean
  /** 成功写入调试库的次数（含新建与覆盖） */
  captured: number
  /** 其中新建的条数 */
  created: number
  /** 其中覆盖已有网址的条数 */
  updated: number
  /** 主动跳过（二进制、空响应、超大、非网页请求） */
  skipped: number
  /** 读取响应体失败 */
  failed: number
  /** 最近一次写入的网址 */
  lastUrl: string | null
  /** 最近一次错误（启动失败 / 单页读取失败），成功后不会自动清空 */
  lastError: string | null
  /** 最近捕获（最新在前，最多 20 条） */
  recent: DebugCaptureItemDto[]
}

/** 启动捕获浏览器的入参。 */
export interface DebugCaptureStartInput {
  /** 可选的起始网址；不填则打开空白页，由用户自行输入 */
  startUrl?: string | null
  /** 同时记录接口 JSON，默认 false */
  includeJson?: boolean
  /** 无头模式，默认 false（要有可见窗口才能手动浏览） */
  headless?: boolean
}
