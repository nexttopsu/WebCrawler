/**
 * 文章内置字段。
 *
 * 列表规则与详情规则共用同一套字段：key、显示名称、提取类型完全一致，
 * 避免两边各写一份后漂移（例如一边叫 `cover`、一边叫 `coverUrl`，
 * 或一边用 `publishTime`、一边用 `articleTime`）。
 *
 * 服务端对这些 key 一律按「平台字段」处理：
 * - 提取到的值落到对应列（title / author / summary / content / coverUrl / articleTime）；
 * - 不会混进 `extra` 自定义字段里。
 *
 * `aliases` 只是读取兼容：老规则里写成 `cover` / `publishTime` 的，
 * 视为已添加过对应内置字段，不再重复出现在「添加内置字段」下拉里。
 */
export interface ArticleFieldPreset {
  key: string
  label: string
  type: 'text' | 'html' | 'attr'
  attribute?: string
  /** 旧写法，读取时视为同一字段 */
  aliases?: string[]
}

export const ARTICLE_FIELD_PRESETS: ArticleFieldPreset[] = [
  { key: 'title', label: '标题', type: 'text' },
  { key: 'url', label: '文章链接', type: 'attr', attribute: 'href' },
  { key: 'author', label: '作者', type: 'text' },
  { key: 'summary', label: '摘要', type: 'text' },
  { key: 'content', label: '正文', type: 'html' },
  { key: 'coverUrl', label: '封面图', type: 'attr', attribute: 'src', aliases: ['cover'] },
  { key: 'articleTime', label: '文章时间', type: 'text', aliases: ['publishTime'] },
]

/**
 * 列表规则的必填字段。
 *
 * 由 Rule Schema 强制（`REQUIRED_LIST_FIELDS`），缺了规则存不进去；
 * 详情规则没有这个约束——详情页的 url 来自列表链接，不需要页面再抽一次。
 */
export const LIST_REQUIRED_FIELD_KEYS: readonly string[] = ['title', 'url']

/**
 * 详情规则的必填字段。
 *
 * 只标 title：管道本身对「缺少标题」有硬校验，标上必填只是让界面提示更明确。
 * 正文不设必填——不少站点详情页只在列表给摘要，正文靠段落拼接，
 * 强制必填会让这类站点整篇判失败。
 */
export const DETAIL_REQUIRED_FIELD_KEYS: readonly string[] = ['title']
