/**
 * 开放（只读）接口契约与接口文档描述。
 *
 * 这些接口面向第三方系统对接：只暴露采集结果的必要字段，不含任务、代理、
 * 规则等内部配置，也不提供任何写操作。字段刻意裁剪成「对外发布」的形态，
 * 不复用管理端 DTO，避免以后管理端加字段时把内部信息顺带暴露出去。
 *
 * `OPEN_API_DOC` 同时是服务端 `GET /api/open/docs` 的返回值与管理后台
 * 「接口文档」页面的渲染数据源：文档与实现共用一份描述，不会各写一遍。
 */

/* -------------------------------------------------------------------------- */
/* 对外 DTO                                                                    */
/* -------------------------------------------------------------------------- */

/** 网站：只给 id、标题与添加时间。 */
export interface OpenSiteDto {
  id: number
  /** 网站名称（即「标题」） */
  name: string
  /** 添加时间（ISO 8601） */
  createdAt: string
}

/** 栏目：标题、id、上级、排序、编码、所属网站、添加时间。 */
export interface OpenCategoryDto {
  id: number
  /** 栏目名称（即「标题」） */
  name: string
  /** 上级栏目 id；`null` 表示顶级栏目 */
  parentId: number | null
  /** 同级排序值，升序展示 */
  sortOrder: number
  /** 栏目编码，未设置时为 null */
  code: string | null
  /** 所属网站 id */
  siteId: number
  /** 添加时间（ISO 8601） */
  createdAt: string
}

/**
 * 网站 + 它的全部栏目。
 *
 * 网站与栏目合成一个接口返回：对接方拉一次就能建出「站点 → 栏目」的导航，
 * 不用再按 siteId 逐个补请求。字段名用 `columns`（栏目）。
 */
export interface OpenSiteWithColumnsDto extends OpenSiteDto {
  /** 该网站下的全部栏目，按 sortOrder、id 升序；没有栏目时为空数组 */
  columns: OpenCategoryDto[]
}

/** 文章列表项：不含正文。 */
export interface OpenArticleSummaryDto {
  id: number
  title: string
  /** 归属网站 id */
  siteId: number
  siteName: string | null
  /** 归属栏目 id；未关联栏目时为 null */
  categoryId: number | null
  categoryName: string | null
  author: string | null
  /** 文章时间（ISO 8601）；原站点未给出时可能为 null */
  articleTime: string | null
  /** 文章链接 */
  url: string
  summary: string | null
  /** 封面图地址；无封面时为 null */
  coverUrl: string | null
}

/** 文章详情：列表字段 + 正文（纯文本）+ 扩展字段。 */
export interface OpenArticleDetailDto extends OpenArticleSummaryDto {
  /** 正文纯文本，可能为空串 */
  content: string
  /**
   * 采集规则中未映射到标准字段的其余自定义字段（键值对）。
   * 只在详情接口返回；没有自定义字段时为空对象。
   */
  extra: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/* 接口文档描述                                                                 */
/* -------------------------------------------------------------------------- */

/** 参数位置：路径参数或查询参数。 */
export type OpenApiParamLocation = 'query' | 'path'

/** 在线调试控件按类型渲染：enum 渲染成下拉框，其余渲染成输入框。 */
export type OpenApiParamType = 'integer' | 'string' | 'enum'

export interface OpenApiParamDoc {
  name: string
  location: OpenApiParamLocation
  type: OpenApiParamType
  required: boolean
  /** 有默认值时调用方可以完全不传 */
  defaultValue?: string
  enumValues?: readonly string[]
  description: string
  /** 在线调试输入框的占位提示 */
  placeholder?: string
}

export interface OpenApiFieldDoc {
  name: string
  type: string
  description: string
}

export interface OpenApiEndpointDoc {
  id: string
  method: 'GET'
  path: string
  title: string
  summary: string
  params: OpenApiParamDoc[]
  response: {
    /**
     * array：data 为数组（元素字段见 fields）；
     * page：data 为分页对象 { items, total, page, pageSize, totalPages }；
     * object：data 为单个对象
     */
    kind: 'array' | 'page' | 'object'
    /** data 的字段；kind=page 时描述 items 数组的元素 */
    fields: OpenApiFieldDoc[]
    /** data 的外层包装字段（仅 kind=page） */
    wrapperFields?: OpenApiFieldDoc[]
    /** 元素里的嵌套数组（如网站的 columns），文档页会单独渲染一张表 */
    nested?: { label: string; fields: OpenApiFieldDoc[] }
  }
  /** 响应示例：服务端与文档页共用，纯展示用 */
  exampleResponse: unknown
  notes: string[]
}

export interface OpenApiDoc {
  version: string
  title: string
  description: string
  /** 接口根地址（相对前端 API 前缀） */
  baseUrl: string
  authorization: string
  /** 通用约定（响应结构、错误码等） */
  conventions: string[]
  endpoints: OpenApiEndpointDoc[]
}

/** 文章列表的分页包装字段。 */
const PAGE_FIELDS: OpenApiFieldDoc[] = [
  { name: 'items', type: 'array', description: '当前页数据' },
  { name: 'total', type: 'integer', description: '符合条件的总条数' },
  { name: 'page', type: 'integer', description: '当前页码，从 1 开始' },
  { name: 'pageSize', type: 'integer', description: '每页条数' },
  { name: 'totalPages', type: 'integer', description: '总页数（空结果时为 1）' },
]

/** 文章列表的分页参数。 */
const PAGE_PARAMS: OpenApiParamDoc[] = [
  {
    name: 'page',
    location: 'query',
    type: 'integer',
    required: false,
    defaultValue: '1',
    description: '页码，从 1 开始',
    placeholder: '1',
  },
  {
    name: 'pageSize',
    location: 'query',
    type: 'integer',
    required: false,
    defaultValue: '20',
    description: '每页条数，取值 1-100（超出返回 400，不静默截断）',
    placeholder: '20',
  },
]

const SITE_FIELDS: OpenApiFieldDoc[] = [
  { name: 'id', type: 'integer', description: '网站 id' },
  { name: 'name', type: 'string', description: '网站名称（标题）' },
  { name: 'createdAt', type: 'string', description: '添加时间，ISO 8601' },
]

const CATEGORY_FIELDS: OpenApiFieldDoc[] = [
  { name: 'id', type: 'integer', description: '栏目 id' },
  { name: 'name', type: 'string', description: '栏目名称（标题）' },
  { name: 'parentId', type: 'integer | null', description: '上级栏目 id，null 表示顶级栏目' },
  { name: 'sortOrder', type: 'integer', description: '同级排序值，升序' },
  { name: 'code', type: 'string | null', description: '栏目编码，未设置时为 null' },
  { name: 'siteId', type: 'integer', description: '所属网站 id' },
  { name: 'createdAt', type: 'string', description: '添加时间，ISO 8601' },
]

const ARTICLE_FIELDS: OpenApiFieldDoc[] = [
  { name: 'id', type: 'integer', description: '文章 id' },
  { name: 'title', type: 'string', description: '标题' },
  { name: 'siteId', type: 'integer', description: '归属网站 id' },
  { name: 'siteName', type: 'string | null', description: '归属网站名称' },
  { name: 'categoryId', type: 'integer | null', description: '归属栏目 id，未关联栏目时为 null' },
  { name: 'categoryName', type: 'string | null', description: '归属栏目名称' },
  { name: 'author', type: 'string | null', description: '作者' },
  { name: 'articleTime', type: 'string | null', description: '文章时间，ISO 8601；原站点未给出时为 null' },
  { name: 'url', type: 'string', description: '文章链接' },
  { name: 'summary', type: 'string | null', description: '摘要纯文本（HTML 片段已去标签、解实体，超长截断到 300 字）' },
  { name: 'coverUrl', type: 'string | null', description: '封面图地址，无封面时为 null' },
]

const ARTICLE_QUERY_PARAMS: OpenApiParamDoc[] = [
  {
    name: 'order',
    location: 'query',
    type: 'enum',
    required: false,
    defaultValue: 'desc',
    enumValues: ['desc', 'asc'],
    description: '文章时间排序：desc 倒序（默认）、asc 正序；缺少文章时间的记录始终排在最后',
  },
  {
    name: 'siteId',
    location: 'query',
    type: 'integer',
    required: false,
    description: '按所属网站筛选',
    placeholder: '不筛选',
  },
  {
    name: 'categoryId',
    location: 'query',
    type: 'integer',
    required: false,
    description: '按所属栏目筛选',
    placeholder: '不筛选',
  },
  {
    name: 'keyword',
    location: 'query',
    type: 'string',
    required: false,
    description: '标题关键词，模糊匹配（% 与 _ 会被转义）',
    placeholder: '不筛选',
  },
  ...PAGE_PARAMS,
]

/** 文章列表的示例数据（含分页包装）。 */
function pageExample(items: unknown[]): unknown {
  return {
    success: true,
    data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
    meta: { requestId: '0f9c1f4e2b7a4d8e', timestamp: '2026-11-09T07:00:00.000Z' },
  }
}

/** 网站 / 栏目列表的示例数据（data 直接是数组）。 */
function arrayExample(items: unknown[]): unknown {
  return {
    success: true,
    data: items,
    meta: { requestId: '0f9c1f4e2b7a4d8e', timestamp: '2026-11-09T07:00:00.000Z' },
  }
}

const SAMPLE_ARTICLE = {
  id: 128,
  title: '城市更新项目在本月启动',
  siteId: 1,
  siteName: '示例新闻站',
  categoryId: 3,
  categoryName: '本地新闻',
  author: '记者 张三',
  articleTime: '2026-11-08T02:30:00.000Z',
  url: 'https://example.com/news/128.html',
  summary: '城市更新项目在本月启动，居民代表参与讨论。',
  coverUrl: 'https://example.com/uploads/128.jpg',
}

/**
 * 接口文档描述（唯一来源）。
 *
 * 只要改了路由的入参或返回字段，就必须同步改这里，文档页面会立刻跟着变；
 * `test/server/open-api.test.ts` 会校验文档里列的路径都能真实访问。
 */
export const OPEN_API_DOC: OpenApiDoc = {
  version: '1.0.0',
  title: 'WebCrawler 数据开放接口',
  description:
    '只读接口，供第三方站点或小程序拉取采集结果（网站、栏目、文章）。所有接口都是 GET，不写入任何数据，也不需要登录。',
  baseUrl: '/api/open',
  authorization: '无需鉴权。生产环境如需限制来源，请在反向代理层做 IP 白名单或签发只读令牌。',
  conventions: [
    '统一响应结构：{"success": true, "data": ..., "meta": {"requestId", "timestamp"}}；失败时为 {"success": false, "error": {"code", "message", "details"}}。',
    '网站接口（含栏目）不分页，data 直接是数组；文章接口分页，data 为 { items, total, page, pageSize, totalPages }，pageSize 上限 100。',
    '时间字段一律为 ISO 8601 UTC 字符串，例如 2026-11-08T02:30:00.000Z。',
    '错误码：VALIDATION_ERROR（参数不合法，400）、NOT_FOUND（资源不存在，404）、METHOD_NOT_ALLOWED（方法与路径不匹配，405）、INTERNAL_ERROR（500）。',
    'JSON 响应均为 application/json; charset=utf-8，可直接被跨域调用（CORS 由服务端配置决定）。',
  ],
  endpoints: [
    {
      id: 'sites',
      method: 'GET',
      path: '/api/open/sites',
      title: '网站列表（含栏目）',
      summary:
        '一次性返回全部网站，每个网站带上它的全部栏目（columns），不分页；数据直接是数组，适合建导航、渲染筛选下拉框。',
      params: [],
      response: {
        kind: 'array',
        fields: [
          ...SITE_FIELDS,
          { name: 'columns', type: 'array', description: '该网站下的全部栏目，按 sortOrder、id 升序；没有栏目时为空数组' },
        ],
        nested: { label: 'columns 的每个元素（栏目）：', fields: CATEGORY_FIELDS },
      },
      exampleResponse: arrayExample([
        {
          id: 1,
          name: '示例新闻站',
          createdAt: '2026-10-01T03:12:00.000Z',
          columns: [
            {
              id: 3,
              name: '本地新闻',
              parentId: null,
              sortOrder: 10,
              code: 'local',
              siteId: 1,
              createdAt: '2026-10-02T06:00:00.000Z',
            },
            {
              id: 4,
              name: '财经',
              parentId: null,
              sortOrder: 20,
              code: 'finance',
              siteId: 1,
              createdAt: '2026-10-02T06:01:00.000Z',
            },
          ],
        },
        {
          id: 2,
          name: '行业资讯网',
          createdAt: '2026-10-06T08:40:00.000Z',
          columns: [],
        },
      ]),
      notes: [
        '网站与栏目合成一个接口：拉一次即可建出「站点 → 栏目」结构，不用按 siteId 逐个补请求。',
        '不分页：data 就是全部网站。网站是配置类数据，数量可控。',
        '不同网站的栏目 id 全局唯一，可直接拿 columns[].id 作为文章列表的 categoryId 筛选。',
        'parentId 只表示组织层级，父栏目本身也是可采集的真实栏目；本接口不返回嵌套树，需要树时用 parentId 自行组装。',
        '站点停用不会从列表里消失：这是配置清单，不是「可采集站点」清单。',
      ],
    },
    {
      id: 'articles',
      method: 'GET',
      path: '/api/open/articles',
      title: '文章列表',
      summary: '分页返回文章摘要（不含正文），支持按文章时间排序、按网站 / 栏目 / 标题关键词筛选。',
      params: ARTICLE_QUERY_PARAMS,
      response: { kind: 'page', fields: ARTICLE_FIELDS, wrapperFields: PAGE_FIELDS },
      exampleResponse: pageExample([SAMPLE_ARTICLE]),
      notes: [
        '排序字段是文章时间（articleTime）而不是入库时间；同秒的记录再按 id 排，保证翻页稳定。',
        '缺少文章时间的记录无论正序还是倒序都排在最后，避免脏数据占满首页。',
        'keyword 只匹配标题，不搜摘要与正文。',
        '摘要返回纯文本：如果采集到的是 HTML 片段，会去标签、解实体并截断到 300 字。',
        '列表不返回正文；正文请调用「文章详情」接口。',
      ],
    },
    {
      id: 'article-detail',
      method: 'GET',
      path: '/api/open/articles/:id',
      title: '文章详情',
      summary: '按 id 返回单篇文章的完整信息，包含正文纯文本与采集扩展字段（extra）。',
      params: [
        {
          name: 'id',
          location: 'path',
          type: 'integer',
          required: true,
          description: '文章 id（正整数）',
          placeholder: '128',
        },
      ],
      response: {
        kind: 'object',
        fields: [
          ...ARTICLE_FIELDS,
          { name: 'content', type: 'string', description: '正文纯文本，可能为空串' },
          {
            name: 'extra',
            type: 'object',
            description: '采集规则未映射到标准字段的其余自定义字段（键值对），没有时为空对象',
          },
        ],
      },
      exampleResponse: {
        success: true,
        data: {
          ...SAMPLE_ARTICLE,
          content: '城市更新项目在本月启动，居民代表参与讨论。项目覆盖三个街道，预计工期 18 个月。',
          extra: { source: 'rss', readCount: 1520 },
        },
        meta: { requestId: '0f9c1f4e2b7a4d8e', timestamp: '2026-11-09T07:00:00.000Z' },
      },
      notes: [
        '正文是采集清洗后的纯文本（保留换行），不含 HTML 标签；需要原始 HTML 请用管理端接口。',
        'extra 是采集规则提取的自定义字段，键名由规则决定，不同文章的键可能不同；列表接口不返回该字段。',
        'id 不是正整数时返回 400；文章不存在时返回 404，error.code 为 NOT_FOUND。',
      ],
    },
  ],
}
