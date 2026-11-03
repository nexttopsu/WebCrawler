/**
 * 数据处理管道：解析 → 清洗 → 校验 → URL 规范化 → 内容 Hash → 输出。
 *
 * 管道与请求层解耦：输入是「已经拿到的响应文本」，因此规则测试器可以复用同一条链路，
 * 正式采集只是多了一步由引擎发请求。
 */
import { createHash } from 'node:crypto'
import type {
  ArticleData,
  ContentCleanRule,
  FieldRule,
  ValidateConfig,
} from '../shared/index.js'
import { absolutizeHtml, cleanHtml, htmlToText } from './clean.js'
import { ParserError } from './errors.js'
import { Parser, createParser } from './parser/index.js'
import { extractFieldsViaHtml2Object } from './parser/html2object-bridge.js'
import type { ExtractionResult, FieldExtraction } from './parser/extract.js'

/** 管道阶段。 */
export type PipelineStage = 'parse' | 'extract' | 'clean' | 'validate' | 'normalize' | 'hash' | 'output'

/** 单个阶段的执行记录。 */
export interface PipelineStep {
  stage: PipelineStage
  ok: boolean
  durationMs: number
  detail?: string
}

/** 管道输入。 */
export interface PipelineInput {
  siteId: string
  categoryId: string
  /** 页面地址，用于相对链接与图片转绝对地址 */
  url: string
  /** 响应文本 */
  body: string
  /** 响应类型，默认 html */
  contentType?: 'html' | 'json'
  fields: Record<string, FieldRule>
  clean?: ContentCleanRule
  validate?: ValidateConfig
  /** 采集时间，默认当前时间；测试可注入固定值 */
  crawlTime?: string
  /** 列表阶段提取的封面图；详情页未映射到 cover/coverUrl 时作为兜底 */
  listCoverUrl?: string
  /** 附加元数据，会与自定义字段一起写入 article.metadata */
  metadata?: Record<string, unknown>
  /**
   * 解析器插件链：在字段提取完成后、清洗校验前调用，可重格式化数据
   * （如图片地址解密）。按顺序执行，抛错视为该篇解析失败。
   */
  transform?: (data: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** 管道输出。 */
export interface PipelineResult {
  /** 校验不通过时为 null */
  article: ArticleData | null
  /** 字段级诊断，供规则测试器展示 */
  fields: Record<string, FieldExtraction>
  missing: string[]
  errors: string[]
  steps: PipelineStep[]
}

/** 已知的顶层文章字段，其余字段视为自定义字段。 */
const KNOWN_FIELDS = new Set([
  'title',
  'author',
  'publishTime',
  'content',
  'html',
  'images',
  // 封面图：预留字段，`cover` 与 `coverUrl` 两种写法都认
  'cover',
  'coverUrl',
])

const sharedParser = createParser()

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return ''
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string' && value) return [value]
  return []
}

function hashContent(title: string, content: string): string {
  return createHash('sha256').update(`${title}\n${content}`, 'utf8').digest('hex')
}

/** 执行数据管道。 */
export async function runPipeline(input: PipelineInput, parser: Parser = sharedParser): Promise<PipelineResult> {
  const steps: PipelineStep[] = []
  const errors: string[] = []

  const record = (stage: PipelineStage, ok: boolean, startedAt: number, detail?: string): void => {
    steps.push({
      stage,
      ok,
      durationMs: Math.round(performance.now() - startedAt),
      ...(detail ? { detail } : {}),
    })
  }

  // 1. 解析（HTML 走 request-pack html2object 桥接；JSON 走 jsonPath 提取器）
  let parseStart = performance.now()
  let extraction: ExtractionResult
  try {
    if (input.contentType === 'json') {
      extraction = parser.extractJsonFields(parser.parseJson(input.body), input.fields, input.validate)
    } else {
      extraction = extractFieldsViaHtml2Object(input.body, input.fields, input.validate)
    }
  } catch (error) {
    const message = error instanceof ParserError ? error.message : String(error)
    record('parse', false, parseStart, message)
    return { article: null, fields: {}, missing: [], errors: [message], steps }
  }
  record('parse', true, parseStart, `匹配字段 ${Object.keys(extraction.data).length} 个`)

  // 1.5 解析器插件：重格式化提取结果（如图片解密）
  if (input.transform) {
    parseStart = performance.now()
    try {
      const transformed = await input.transform(extraction.data)
      extraction = {
        ...extraction,
        data: transformed,
      }
      record('parse', true, parseStart, '解析器插件已执行')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record('parse', false, parseStart, message)
      return { article: null, fields: extraction.fields, missing: extraction.missing, errors: [message], steps }
    }
  }

  errors.push(...extraction.errors)

  // 2. 清洗
  parseStart = performance.now()
  const contentRule = input.fields.content
  const rawHtml = typeof extraction.data.html === 'string' ? extraction.data.html : ''
  const rawContent = typeof extraction.data.content === 'string' ? extraction.data.content : ''
  const contentIsHtml = contentRule?.type === 'html'
  const cleanOptions = { removeSelectors: input.clean?.removeSelectors }

  let html = ''
  if (rawHtml) {
    html = cleanHtml(rawHtml, cleanOptions)
  } else if (contentIsHtml && rawContent) {
    // content 配成 html 类型时，HTML 正文同时作为文章 html
    html = cleanHtml(rawContent, cleanOptions)
  }
  if (input.clean?.keepImages === false && html) {
    html = cleanHtml(html, { removeSelectors: [...(input.clean.removeSelectors ?? []), 'img'] })
  }
  if (html) html = absolutizeHtml(html, (value) => parser.resolveUrl(value, input.url))

  let content = ''
  if (contentIsHtml) {
    content = htmlToText(html || rawContent)
  } else {
    content = stringValue(rawContent)
  }
  if (!content && html) content = htmlToText(html)
  if (!html && content) html = `<p>${content}</p>`

  const images = (() => {
    const explicit = stringArray(extraction.data.images)
    if (explicit.length > 0) {
      return [...new Set(explicit.map((item) => parser.resolveUrl(item, input.url)))]
    }
    const source = html || rawContent
    return source ? parser.extractImages(source, input.url) : []
  })()

  // 封面图优先级：详情页显式映射（cover / coverUrl）> 列表阶段提取的封面；
  // 都取不到就留空（null），不在这里猜测「首图即封面」。
  const coverSource =
    stringValue(extraction.data.coverUrl) || stringValue(extraction.data.cover) || input.listCoverUrl || ''
  const coverRaw = coverSource ? parser.resolveUrl(coverSource.trim(), input.url) : ''
  // 封面会直接进入前端 <img src>，只接受 http(s) 绝对地址，伪协议一律留空
  const coverUrl = /^https?:\/\//i.test(coverRaw) ? coverRaw : null

  record('clean', true, parseStart, `正文 ${content.length} 字，图片 ${images.length} 张`)

  // 3. 校验
  parseStart = performance.now()
  const title = stringValue(extraction.data.title)
  const validationErrors = new Set<string>()

  if (!title.trim()) {
    validationErrors.add('缺少标题')
  } else if (input.validate?.minTitleLength && title.length < input.validate.minTitleLength) {
    validationErrors.add(`标题长度不足 ${input.validate.minTitleLength} 字`)
  }
  if (input.validate?.minContentLength && content.length < input.validate.minContentLength) {
    validationErrors.add(`正文长度不足 ${input.validate.minContentLength} 字`)
  }

  // 标题缺失已单独提示，避免重复列出
  const missingFields = extraction.missing.filter((key) => !(key === 'title' && !title.trim()))
  if (missingFields.length > 0) {
    validationErrors.add(`必填字段缺失：${missingFields.join('、')}`)
  }

  const validationList = [...validationErrors]
  record('validate', validationList.length === 0, parseStart, validationList.join('；') || undefined)
  if (validationList.length > 0) {
    return {
      article: null,
      fields: extraction.fields,
      missing: extraction.missing,
      errors: [...new Set([...errors, ...validationList])],
      steps,
    }
  }

  // 4. URL 规范化
  parseStart = performance.now()
  let url: string
  try {
    url = parser.normalizeUrl(input.url)
  } catch {
    url = input.url
  }
  record('normalize', true, parseStart, url)

  // 5. 内容 Hash
  parseStart = performance.now()
  const contentHash = hashContent(title, content)
  record('hash', true, parseStart, contentHash.slice(0, 12))

  // 6. 输出
  parseStart = performance.now()
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) }
  for (const [key, value] of Object.entries(extraction.data)) {
    if (KNOWN_FIELDS.has(key)) continue
    metadata[key] = value
  }

  const article: ArticleData = {
    siteId: input.siteId,
    categoryId: input.categoryId,
    title: title.trim(),
    url,
    images,
    coverUrl,
    contentHash,
    crawlTime: input.crawlTime ?? new Date().toISOString(),
  }
  const author = stringValue(extraction.data.author)
  if (author) article.author = author
  const publishTime = stringValue(extraction.data.publishTime)
  if (publishTime) article.publishTime = publishTime
  if (content) article.content = content
  if (html) article.html = html
  if (Object.keys(metadata).length > 0) article.metadata = metadata

  record('output', true, parseStart, `文章「${article.title}」`)

  return {
    article,
    fields: extraction.fields,
    missing: extraction.missing,
    errors,
    steps,
  }
}
