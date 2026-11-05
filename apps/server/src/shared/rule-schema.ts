import { z } from 'zod'
import type { CrawlRuleConfig, FieldRule, PaginationConfig } from './crawl.js'

/**
 * 采集规则的 JSON Schema。
 *
 * 规则是「可校验的 JSON」：写入数据库前必须通过这里的校验，
 * 服务端与规则测试器共用同一套 Schema，避免两处判定不一致。
 *
 * 设计约定：
 * - 所有对象都是 strict（未知字段直接报错），拼写错误不会被静默忽略；
 * - `version` 是**规则结构版本**，当前只支持 1；规则自身的修订号存在 `crawl_rule.version`；
 * - 分页类型全部保留在枚举中，但 `next` / `cursor` 在第一版会明确报错（见 `checkPagination`）。
 */

/** 当前支持的规则结构版本。 */
export const RULE_SCHEMA_VERSION = 1

/** 第一版已实现的分页类型。 */
export const SUPPORTED_PAGINATION_TYPES = ['none', 'query', 'path'] as const

/** 已预留、但第一版尚未实现的分页类型。 */
export const RESERVED_PAGINATION_TYPES = ['next', 'cursor'] as const

const MAX_SELECTOR_LENGTH = 500
const MAX_URL_LENGTH = 2048
const MAX_FIELD_DEPTH = 8

/** 字段名：入库后会成为文章数据中的键，限制为标识符，避免下游映射时出现歧义。 */
const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const fieldNameSchema = z
  .string()
  .trim()
  .regex(FIELD_KEY_PATTERN, '字段名只能包含字母、数字与下划线，且不能以数字开头')

/** HTTP 头名称必须符合 RFC 7230 的 token 规则，防止头注入。 */
const headerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, '请求头名称不合法')

const headerValueSchema = z
  .string()
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), '请求头值不能包含换行符')

const headerMapSchema = z.record(headerNameSchema, headerValueSchema)

const urlSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(MAX_URL_LENGTH)
    .refine((value) => /^https?:\/\//i.test(value), `${label}必须是 http(s) 绝对地址`)

const selectorSchema = z.string().trim().min(1).max(MAX_SELECTOR_LENGTH)

/** 字段级清洗规则。 */
export const fieldCleanRuleSchema = z
  .object({
    trim: z.boolean().optional(),
    collapseWhitespace: z.boolean().optional(),
    removePattern: z.string().min(1).max(300).optional(),
    replace: z
      .object({
        pattern: z.string().min(1).max(300),
        with: z.string().max(300),
      })
      .strict()
      .optional(),
  })
  .strict()

/** addIssue 的最小结构，避免 zod 内部类型泄漏到辅助函数签名里。 */
interface IssueSink {
  addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void
}

/**
 * 校验字段映射的键名。
 *
 * zod 的 `z.record(keySchema, ...)` 在键不匹配时只会给出英文的
 * "Invalid key in record"，对使用者没有指导意义，因此键名单独校验。
 */
function validateFieldKeys(value: Record<string, unknown>, ctx: IssueSink): void {
  for (const key of Object.keys(value)) {
    if (!FIELD_KEY_PATTERN.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `字段名「${key}」不合法：只能包含字母、数字与下划线，且不能以数字开头`,
      })
    }
  }
}

/** 字段映射：键名单独校验，值递归复用字段规则。 */
function createFieldsMapSchema() {
  return z
    .record(z.string(), fieldRuleSchema)
    .superRefine((value, ctx) => validateFieldKeys(value, ctx))
}

/**
 * 单个字段的提取规则。
 *
 * 递归引用自身，用于 `object` / `list` 的嵌套字段；
 * 深度上限由 `assertFieldDepth` 控制，避免恶意配置造成递归过深。
 */
export const fieldRuleSchema: z.ZodType<FieldRule, unknown> = z.lazy(() =>
  z
    .object({
      type: z.enum(['text', 'html', 'attr', 'list', 'object']),
      selector: selectorSchema.optional(),
      attribute: z
        .string()
        .trim()
        .regex(/^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/, '属性名不合法')
        .optional(),
      multiple: z.boolean().optional(),
      required: z.boolean().optional(),
      defaultValue: z.string().max(2000).optional(),
      fields: createFieldsMapSchema().optional(),
      jsonPath: z.string().trim().min(1).max(300).optional(),
      clean: fieldCleanRuleSchema.optional(),
    })
    .strict()
    .superRefine((rule, ctx) => {
      const needsSelector = rule.type === 'text' || rule.type === 'html' || rule.type === 'attr'
      if (needsSelector && !rule.selector && !rule.jsonPath) {
        ctx.addIssue({
          code: 'custom',
          path: ['selector'],
          message: `type=${rule.type} 时必须提供 selector 或 jsonPath`,
        })
      }
      if (rule.type === 'attr' && !rule.attribute && !rule.jsonPath) {
        ctx.addIssue({ code: 'custom', path: ['attribute'], message: 'type=attr 时必须提供 attribute' })
      }
      if ((rule.type === 'list' || rule.type === 'object') && !rule.fields) {
        ctx.addIssue({ code: 'custom', path: ['fields'], message: `type=${rule.type} 时必须提供 fields` })
      }
      if ((rule.type === 'text' || rule.type === 'html') && rule.fields) {
        ctx.addIssue({ code: 'custom', path: ['fields'], message: `type=${rule.type} 不支持嵌套 fields` })
      }
    }),
)

const fieldsMapSchema = createFieldsMapSchema()

/** 检查嵌套深度：zod 的递归 Schema 不会限制深度，超深配置在提取阶段会拖垮进程。 */
function assertFieldDepth(
  rules: Record<string, FieldRule>,
  depth: number,
  ctx: IssueSink,
  path: (string | number)[] = [],
): void {
  if (depth > MAX_FIELD_DEPTH) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `字段嵌套深度不能超过 ${MAX_FIELD_DEPTH} 层`,
    })
    return
  }
  for (const [key, rule] of Object.entries(rules)) {
    if (rule.fields) assertFieldDepth(rule.fields, depth + 1, ctx, [...path, key, 'fields'])
  }
}

/** 分页配置。 */
export const paginationSchema = z
  .object({
    type: z.enum(['none', 'query', 'path', 'next', 'cursor']),
    parameter: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/, '页码参数名不合法')
      .optional(),
    start: z.number().int().min(1).max(10_000).optional(),
    pathPattern: z.string().trim().min(1).max(300).optional(),
    nextSelector: selectorSchema.optional(),
    cursorParameter: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/, '游标参数名不合法')
      .optional(),
  })
  .strict()

/**
 * 分页配置的语义校验。
 *
 * 返回错误列表而不是直接抛错，便于 Schema 与 Service 共用同一套判定。
 * 未实现的类型（next / cursor）在这里明确报错，不做静默忽略。
 */
export function checkPagination(config: PaginationConfig | undefined): string[] {
  if (!config) return []

  const errors: string[] = []
  const type = config.type

  if ((RESERVED_PAGINATION_TYPES as readonly string[]).includes(type)) {
    errors.push(
      `分页类型 ${type} 尚未实现（计划随任务调度阶段提供），当前仅支持 ${SUPPORTED_PAGINATION_TYPES.join(' / ')}`,
    )
  }

  if (type === 'query' && !config.parameter) {
    errors.push('query 分页必须提供 parameter（页码参数名）')
  }
  if (type === 'path') {
    if (!config.pathPattern) {
      errors.push('path 分页必须提供 pathPattern')
    } else if (!config.pathPattern.includes('{page}')) {
      errors.push('path 分页的 pathPattern 必须包含 {page} 占位符')
    }
  }
  if (type === 'next' && !config.nextSelector) {
    errors.push('next 分页必须提供 nextSelector')
  }
  if (type === 'cursor' && !config.cursorParameter) {
    errors.push('cursor 分页必须提供 cursorParameter')
  }

  return errors
}

/** 列表页字段配置里必须存在的字段。 */
export const REQUIRED_LIST_FIELDS = ['title', 'url'] as const

/** 解析器插件名，与插件清单命名规则一致。 */
const parserPluginNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '解析器插件名不合法')

/** 全流程插件 id（config.id），与插件命名规则一致。 */
const flowPluginIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '插件 id 不合法')

/** 列表页规则。 */
export const listRuleSchema = z
  .object({
    /** 全流程插件 id：配置后由插件接管列表解析，itemSelector 可省略 */
    plugin: flowPluginIdSchema.optional(),
    url: urlSchema('列表页地址').optional(),
    itemSelector: selectorSchema.optional(),
    fields: createFieldsMapSchema().optional(),
    linkSelector: selectorSchema.optional(),
    titleSelector: selectorSchema.optional(),
    linkAttribute: z
      .string()
      .trim()
      .regex(/^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/, '链接属性名不合法')
      .optional(),
    coverSelector: selectorSchema.optional(),
    coverAttribute: z
      .string()
      .trim()
      .regex(/^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/, '封面属性名不合法')
      .optional(),
    pagination: paginationSchema.optional(),
    /** 列表阶段的解析器插件链（与顶层 parserPlugins / 详情阶段互不影响） */
    parserPlugins: z.array(parserPluginNameSchema).max(10).optional(),
    /** 列表阶段排除选择器：提取前先删除命中的节点 */
    excludeSelectors: z.array(selectorSchema).max(20).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (!rule.plugin && !rule.itemSelector) {
      ctx.addIssue({
        code: 'custom',
        path: ['itemSelector'],
        message: '未配置列表插件时必须提供 itemSelector',
      })
    }
    if (rule.plugin && (rule.linkSelector || rule.titleSelector)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plugin'],
        message: '列表插件与 linkSelector / titleSelector 不能同时使用',
      })
    }
    if (!rule.fields) return
    for (const key of REQUIRED_LIST_FIELDS) {
      if (!(key in rule.fields)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `列表字段配置缺少必填字段 "${key}"`,
        })
      }
    }
  })

/** 详情页规则。 */
export const detailRuleSchema = z
  .object({
    /** 全流程插件 id：配置后由插件抓取并解析详情页，fields 不再需要 */
    plugin: flowPluginIdSchema.optional(),
    method: z.enum(['GET', 'POST']).optional(),
    fields: fieldsMapSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.plugin && rule.fields) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: '详情插件与字段映射不能同时配置，二选一',
      })
    }
  })

/** 请求级代理设置。`null` 表示显式直连，覆盖上层的代理配置。 */
export const proxySettingsSchema = z
  .object({
    protocol: z.enum(['http', 'https'], {
      message: '代理协议仅支持 http / https',
    }),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(256).optional(),
    password: z.string().max(256).optional(),
  })
  .strict()

/** 请求阶段规则。 */
export const ruleRequestSchema = z
  .object({
    mode: z.enum(['http', 'browser']).optional(),
    method: z.enum(['GET', 'POST']).optional(),
    headers: headerMapSchema.optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    // 规则示例里常见的写法，归一化时折叠为 timeoutMs
    timeout: z.number().int().min(1000).max(120_000).optional(),
    encoding: z.string().trim().min(1).max(32).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .optional(),
    maxRedirects: z.number().int().min(0).max(10).optional(),
    userAgent: z.string().trim().min(1).max(512).optional(),
    cookies: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
    proxy: proxySettingsSchema.nullable().optional(),
  })
  .strict()

/** 整篇文章的清洗规则。 */
export const contentCleanRuleSchema = z
  .object({
    removeSelectors: z.array(selectorSchema).max(20).optional(),
    keepImages: z.boolean().optional(),
  })
  .strict()

/** 数据校验规则。 */
export const validateConfigSchema = z
  .object({
    requiredFields: z.array(fieldNameSchema).max(50).optional(),
    minTitleLength: z.number().int().min(0).max(500).optional(),
    minContentLength: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()

/** 浏览器渲染规则。 */
export const browserRuleSchema = z
  .object({
    enabled: z.boolean().optional(),
    waitUntil: z.enum(['domcontentloaded', 'load', 'networkidle']).optional(),
    waitForSelector: selectorSchema.optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    blockResources: z.boolean().optional(),
    userAgent: z.string().trim().min(1).max(512).optional(),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
      })
      .strict()
      .optional(),
  })
  .strict()

/**
 * 完整的采集规则。
 *
 * `pagination` 有顶层与 `list.pagination` 两个位置：两者等价，
 * 同时出现时必须完全一致（由 superRefine 校验），
 * 归一化后统一写入两处，保证引擎与调度器读到的值相同。
 */
export const crawlRuleConfigSchema = z
  .object({
    version: z.literal(RULE_SCHEMA_VERSION, {
      message: `规则结构版本仅支持 ${RULE_SCHEMA_VERSION}`,
    }),
    request: ruleRequestSchema.optional(),
    list: listRuleSchema.optional(),
    /** 默认采集范围：list 只抓列表，full 列表 + 详情；缺省视为 full */
    collectScope: z.enum(['list', 'full'], {
      message: '采集范围仅支持 list（仅列表）或 full（列表 + 详情）',
    }).optional(),
    pagination: paginationSchema.optional(),
    detail: detailRuleSchema.optional(),
    fields: fieldsMapSchema.optional(),
    /** 解析器插件链，按数组顺序在提取后执行 */
    parserPlugins: z.array(parserPluginNameSchema).max(10).optional(),
    /** 详情阶段排除选择器：提取前先删除命中的节点 */
    excludeSelectors: z.array(selectorSchema).max(20).optional(),
    clean: contentCleanRuleSchema.optional(),
    validate: validateConfigSchema.optional(),
    browser: browserRuleSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const fromList = config.list?.pagination
    const fromTop = config.pagination

    if (fromList && fromTop && JSON.stringify(fromList) !== JSON.stringify(fromTop)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pagination'],
        message: 'list.pagination 与 pagination 不能同时设置不同的值',
      })
    }

    for (const message of checkPagination(fromTop ?? fromList)) {
      ctx.addIssue({ code: 'custom', path: ['pagination'], message })
    }

    if (config.fields) assertFieldDepth(config.fields, 1, ctx, ['fields'])
    if (config.detail?.fields) assertFieldDepth(config.detail.fields, 1, ctx, ['detail', 'fields'])

    const detailFields = config.detail?.fields ?? {}
    const topFields = config.fields ?? {}
    if (Object.keys(detailFields).length > 0 && Object.keys(topFields).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['detail', 'fields'],
        message: '字段映射只能放在 detail.fields 或顶层 fields 其中之一',
      })
    }

    if (
      config.request?.timeout !== undefined &&
      config.request.timeoutMs !== undefined &&
      config.request.timeout !== config.request.timeoutMs
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['request', 'timeout'],
        message: 'timeout 与 timeoutMs 不能同时设置不同的值',
      })
    }

    if (config.browser?.enabled && config.request?.mode === 'http') {
      ctx.addIssue({
        code: 'custom',
        path: ['browser', 'enabled'],
        message: 'request.mode=http 与 browser.enabled=true 冲突',
      })
    }

    // 仅列表采集必须先有列表规则，否则任务创建时无从下手
    if (config.collectScope === 'list' && !config.list) {
      ctx.addIssue({
        code: 'custom',
        path: ['collectScope'],
        message: '采集范围设为「仅列表」时必须配置 list 规则',
      })
    }
  })

/** 编译期断言：Schema 输出必须仍然是 `CrawlRuleConfig`，防止两处定义漂移。 */
export type RuleConfigSchemaOutput = z.output<typeof crawlRuleConfigSchema> extends CrawlRuleConfig
  ? z.output<typeof crawlRuleConfigSchema>
  : never

/** 解析结果：成功返回值，失败返回字段级错误。 */
export type RuleConfigParseResult =
  | { success: true; config: CrawlRuleConfig }
  | { success: false; issues: Array<{ path: string; message: string }> }

/**
 * 清洗历史遗留的分页字段。
 *
 * 旧版规则允许在 `pagination` / `list.pagination` 里写 `maxPages`，
 * 现在页数范围统一由任务的「开始分页 / 结束分页」控制；
 * 这里在解析前静默丢弃该字段，保证存量规则仍能通过 strict 校验。
 */
function stripLegacyPaginationFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const clone: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const key of ['pagination'] as const) {
    const value = clone[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { maxPages: _ignored, ...rest } = value as Record<string, unknown>
      clone[key] = rest
    }
  }
  const list = clone.list
  if (typeof list === 'object' && list !== null && !Array.isArray(list)) {
    const listClone = { ...(list as Record<string, unknown>) }
    const pagination = listClone.pagination
    if (typeof pagination === 'object' && pagination !== null && !Array.isArray(pagination)) {
      const { maxPages: _ignored, ...rest } = pagination as Record<string, unknown>
      listClone.pagination = rest
    }
    clone.list = listClone
  }
  return clone
}

/** 校验规则配置。写入规则、规则测试、任务覆盖规则都先过这一关。 */
export function parseRuleConfig(input: unknown): RuleConfigParseResult {
  const result = crawlRuleConfigSchema.safeParse(stripLegacyPaginationFields(input))
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }
  return { success: true, config: result.data as CrawlRuleConfig }
}

/** 校验失败时的错误摘要，用于日志与异常消息。 */
export function formatRuleIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('；')
}

/** 新建规则时的最小可用配置。 */
export function createDefaultRuleConfig(): CrawlRuleConfig {
  return {
    version: RULE_SCHEMA_VERSION,
    request: { mode: 'http', method: 'GET', timeoutMs: 15_000 },
    pagination: { type: 'none' },
  }
}
