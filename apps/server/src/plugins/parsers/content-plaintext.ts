/**
 * 内置插件 · 解析器（详情专用）
 *
 * 把详情阶段的 content 字段从 HTML 转成纯文本，并按段落分段。
 *
 * 为什么不用 ctx.parser.htmlToText：它走 cheerio 的 `.text()`，
 * 块级标签之间不会产生任何分隔符（`<p>a</p><p>b</p>` → "ab"），
 * 段落边界全部丢失。本插件在删标签之前先给块级元素插入换行：
 *
 * - 段落级标签（p / div / h1-h6 / blockquote / ul / table …）→ 空行（`\n\n`）
 * - 行内换行（`<br>`）与列表项 / 表格行（li / tr / dt）→ 单换行（`\n`）
 * - `<script>` / `<style>` / 注释等无正文价值的块整体移除
 * - HTML 实体（`&nbsp;` `&amp;` `&#8212;` …）解码后再清洗空白
 *
 * 管道兼容性：解析器插件在字段提取后、清洗校验前执行；content 字段
 * 配成 `type: "html"` 时，管道随后会再跑一次 htmlToText——它只折叠
 * 行内空白、保留换行（` *\n *` → `\n`），所以这里的分段能原样落库。
 *
 * 纯字符串实现，不引第三方包：规则测试器里随手可跑，也没有构建负担。
 */
import { definePlugin } from '../../plugin-system/sdk.js'

/** 无正文价值、整块移除的标签（内容也不保留）。 */
const STRIP_WITH_CONTENT = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'head',
]

/** 段落级标签：开/闭标签都视为一次段落分隔（连续的分隔最终会合并）。 */
const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'figure', 'figcaption', 'address', 'fieldset',
  'ul', 'ol', 'dl', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'caption',
  'hr',
]

const STRIP_TAG_GROUP = `(?:${STRIP_WITH_CONTENT.join('|')})`
const STRIP_RE = new RegExp(`<${STRIP_TAG_GROUP}\\b[^>]*>[\\s\\S]*?</${STRIP_TAG_GROUP}\\s*>`, 'gi')
/** 列表里不成对的元素（input / br 一类空标签）：只删标签本身。 */
const VOID_STRIP_RE = new RegExp(`<${STRIP_TAG_GROUP}\\b[^>]*/?>`, 'gi')

/** 段落分隔占位符：先用不会出现在正文里的记号，避免与正文换行混淆。 */
const PARAGRAPH_MARK = '\u0000P\u0000'
const LINE_MARK = '\u0000L\u0000'

const BLOCK_TAG_RE = new RegExp(`</?(?:${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi')
/**
 * 行级标签：产生单个换行（列表项、表格行、定义术语）。
 * 只在开标签处断行：`</li><li>` 相邻时不会出现两次换行；
 * 实际页面里省略 `</li>` 的写法也照样每项一行。
 */
const LINE_TAG_RE = /<(?:li|dt|tr)\b[^>]*>/gi
const BR_TAG_RE = /<br\b[^>]*>/gi
const TD_TAG_RE = /<\/?(?:td|th)\b[^>]*>/gi

/** 常用命名实体 → 字符。数值实体单独处理。 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  times: '\u00d7',
  divide: '\u00f7',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  ccedil: '\u00e7',
  ugrave: '\u00f9',
}

/** 解码 HTML 实体：命名 + 十进制 `&#123;` + 十六进制 `&#x1F;`。 */
function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      // 只还原可打印字符，控制字符（含 \u0000）一律按空串处理，避免破坏占位符
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ''
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

/**
 * HTML → 分段纯文本。
 *
 * 无标签的输入也允许：只做空白归一（行内折叠、保留既有换行）。
 */
export function htmlToParagraphText(input: string): string {
  if (!input) return ''

  let text = input
    // 统一换行符，去掉零宽字符（与平台 cleanText 同一套口径）
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')

  // 1. 整块移除 script / style / 注释等（先于其它替换，避免其内容混进正文）
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(STRIP_RE, ' ')
  text = text.replace(VOID_STRIP_RE, ' ')

  // 2. 块级 / 行级标签换成换行占位符
  text = text.replace(BLOCK_TAG_RE, PARAGRAPH_MARK)
  text = text.replace(LINE_TAG_RE, LINE_MARK)
  text = text.replace(BR_TAG_RE, LINE_MARK)
  // 单元格之间给一个空隙，避免 "12030" 这种数字粘连
  text = text.replace(TD_TAG_RE, ' ')

  // 3. 删除其余所有标签（以字母 / ! / / 开头才算标签，正文里的 "<3" 不受影响）
  text = text.replace(/<[a-zA-Z!/][^>]*>/g, ' ')

  // 4. 解码实体（在上一步之后做，避免解码出的 < > 被误当标签删掉）
  text = decodeEntities(text)

  // 5. 还原占位符 → 换行；行内空白折叠；去掉行首尾空白
  text = text
    .replace(new RegExp(PARAGRAPH_MARK, 'g'), '\n\n')
    .replace(new RegExp(LINE_MARK, 'g'), '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')

  // 6. 整理：合并 3 个以上连续换行为一个空行（保留段落间的单个空行），收尾 trim。
  //    注意不能删除空行——空行本身就是段落分隔。
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** 是否值得走 HTML 转换：出现任意标签或实体即视为 HTML。 */
function looksLikeHtml(input: string): boolean {
  return /<[a-zA-Z!/][^>]*>/.test(input) || /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/.test(input)
}

export default definePlugin({
  config: {
    id: 'parser-content-plaintext',
    name: '正文转纯文本（保留分段）',
    type: 'parser',
    version: '1.0.0',
    description:
      '详情阶段把 content 字段的 HTML 标签删掉，转为纯文本；',
  },

  /** 详情阶段：整篇文章执行一次。只处理 content，其余字段原样透传。 */
  async parseDetail(url, fields, ctx) {
    const content = fields.content
    if (typeof content !== 'string' || !content.trim()) {
      ctx.logger.warn(`content 为空，跳过纯文本转换：${url}`)
      return fields
    }

    const plain = htmlToParagraphText(content)
    if (!plain) {
      // 转完为空（例如 content 只有一张图）：保留原值，交给管道校验去判定
      ctx.logger.warn(`content 转换后为空文本，保留原值：${url}`)
      return fields
    }

    if (!looksLikeHtml(content)) {
      ctx.logger.info(`content 无 HTML 标签，仅做空白归一：${url}`)
    }

    return { ...fields, content: plain }
  },
})
