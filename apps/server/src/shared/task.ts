import type { CrawlRuleConfig } from './crawl.js'
import type {
  CrawlTaskStatus,
  CrawlTaskTrigger,
  CrawlTaskType,
} from './domain.js'

/**
 * 采集任务的数据契约。
 *
 * `configSnapshot` 是任务启动时固化下来的执行依据：站点基址、每个栏目的
 * 列表地址与「已合并、已校验」的规则。任务运行期间修改规则或栏目不会影响
 * 已在队列中的任务，历史任务也能凭快照复现。
 */

/** 任务执行参数。全部可选，缺省值在服务层收敛。 */
export interface TaskOptions {
  /** 每个栏目最多处理多少篇，缺省不限制 */
  limit?: number
  /** 覆盖规则中的分页页数上限 */
  maxPages?: number
  /** 单篇失败重试次数（不含首次），默认 1 */
  retries?: number
  /** 同一栏目的最小请求间隔（毫秒），默认 300 */
  rateLimitMs?: number
  /** 仅采集发布时间不早于该时刻的文章（ISO 8601） */
  publishedAfter?: string
  /** 仅采集发布时间不晚于该时刻的文章（ISO 8601） */
  publishedBefore?: string
  /** 是否启用增量：跳过已存在于库中的 URL，默认跟随任务类型 */
  incremental?: boolean
  /** 任务总时长上限（毫秒），默认 30 分钟 */
  maxDurationMs?: number
  /** 是否按规则翻页，默认 true */
  followPagination?: boolean
}

/** 单个栏目的规则快照。 */
export interface TaskCategorySnapshot {
  categoryId: number
  name: string
  listUrl: string
  /** 生效规则的来源规则 id（可能来自站点默认规则） */
  ruleId: number | null
  ruleVersion: number
  /** 已按「站点 < 栏目 < 任务覆盖」合并后的完整规则 */
  config: CrawlRuleConfig
  /** 该栏目实际使用的代理；null 表示直连 */
  proxyId: number | null
}

/** 任务配置快照。 */
export interface TaskConfigSnapshot {
  siteId: number
  siteName: string
  baseUrl: string
  categories: TaskCategorySnapshot[]
  /** `urls` 类型任务的显式地址 */
  urls: string[]
  options: TaskOptions
}

/** 任务断点。执行器每处理完一页或一批 URL 后落盘，重启后可判断进度。 */
export interface TaskCheckpoint {
  /** 已完成的栏目 id */
  completedCategoryIds: number[]
  /** 当前栏目已抓取的页码 */
  page: number
  /** 当前栏目已处理的文章 URL（规范化后） */
  processedUrls: string[]
  /** 最后处理的 URL，便于排查中断位置 */
  lastUrl: string | null
  updatedAt: string
}

/** 任务进度统计。 */
export interface TaskProgressDto {
  total: number
  success: number
  failed: number
  skipped: number
  currentPage: number
  totalPages: number
  /** 0-100；总数为 0 时按「已结束则 100，否则 0」处理 */
  percent: number
}

/** 任务列表项。 */
export interface TaskDto {
  id: number
  name: string
  siteId: number
  siteName: string | null
  categoryIds: number[]
  type: CrawlTaskType
  status: CrawlTaskStatus
  trigger: CrawlTaskTrigger
  scheduleId: number | null
  progress: TaskProgressDto
  options: TaskOptions
  attempts: number
  errorSummary: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 任务详情：额外返回快照、断点与栏目名。 */
export interface TaskDetailDto extends TaskDto {
  categories: Array<{ id: number; name: string; listUrl: string }>
  configSnapshot: TaskConfigSnapshot | null
  checkpoint: TaskCheckpoint | null
}

/** 创建任务的输入（服务端 Schema 的对外形态）。 */
export interface CreateTaskInput {
  name?: string
  siteId: number
  type: CrawlTaskType
  categoryIds?: number[]
  urls?: string[]
  /** 覆盖站点/栏目规则的临时规则（结构由 Rule Schema 校验） */
  ruleOverride?: unknown
  options?: TaskOptions
}

/** 任务执行结果摘要，供 API 与日志复用。 */
export interface TaskRunSummary {
  taskId: number
  status: CrawlTaskStatus
  total: number
  success: number
  failed: number
  skipped: number
  elapsedMs: number
  errorSummary: string | null
}
