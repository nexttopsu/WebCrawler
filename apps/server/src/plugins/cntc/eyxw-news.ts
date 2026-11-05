/**
 * 中国儿童艺术剧院 · 儿艺新闻（全流程插件）
 *
 * 站点：https://www.cntc.org.cn（儿艺）
 * 栏目：儿艺新闻 https://www.cntc.org.cn/Column-10.html（分页 Column-10_{page}.html）
 *
 * 全流程插件：列表 / 详情的抓取与解析都由本插件完成，
 * 规则里只需要填分页方式（path：Column-10_{page}.html）。
 *
 * 该栏目混排两类文章，详情解析按来源分两路：
 * - 儿艺官网：.detail-wrapper 内 h3.title + p.author + div.context
 * - 微信公众号外链（mp.weixin.qq.com）：h1.rich_media_title + #js_content
 *
 * 页面解析用的是平台注入的 ctx.html2object + ctx.schema（request-pack），
 * 按 schema 一次解析整页，不用插件自己引依赖。
 */
import { definePlugin, type FlowListItem, type PluginContext } from '../../plugin-system/sdk.js'

/** 详情页「来源：xxx　更新时间：2026-10-23　查看次数：…」里抠发布日期 */
function extractTime(line: string): string {
  const match = line.match(/更新时间[:：]\s*(\d{4}-\d{1,2}-\d{1,2})/)
  return match?.[1] ?? ''
}

/** 微信公众号文章：标题在 h1.rich_media_title / og:title，正文在 #js_content（图片为 data-src 懒加载）。 */
function wechatDetail(html: string, ctx: PluginContext) {
  const data = ctx.html2object(html, {
    title: ctx.schema.text('h1.rich_media_title'),
    ogTitle: ctx.schema.attr('content', 'meta[property="og:title"]'),
    author: ctx.schema.text('#js_name'),
    time: ctx.schema.text('#publish_time'),
    content: ctx.schema.html('#js_content'),
  })

  const title = ctx.parser.cleanText(data.title) || ctx.parser.cleanText(data.ogTitle)
  if (!title) throw new Error('微信文章没有解析到标题')

  // 图片懒加载：把 data-src 转成真正的 src
  let content = data.content
  content = content.replace(/(<img[^>]*?)\sdata-src="([^"]*)"/gi, (_m, head: string, src: string) => `${head} src="${src}"`)
  content = content.replace(/(<img[^>]*?)\ssrc="data:[^"]*"/gi, '$1')

  // 发布时间优先用页面上的 #publish_time，缺失时退回 JS 变量 createTime = '2026-10-20 15:59'
  const time =
    ctx.parser.cleanText(data.time) ||
    html.match(/createTime\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
    ''

  return {
    title,
    author: ctx.parser.cleanText(data.author),
    articleTime: time,
    content,
  }
}

/** 儿艺官网新闻详情。 */
function siteDetail(html: string, ctx: PluginContext, finalUrl: string) {
  const data = ctx.html2object(html, {
    title: ctx.schema.text('.detail-wrapper h3.title'),
    authorLine: ctx.schema.text('.detail-wrapper p.author'),
    content: ctx.schema.html('.detail-wrapper .context'),
  })

  const title = ctx.parser.cleanText(data.title)
  if (!title) throw new Error('详情页没有解析到标题')

  // 正文里的图片是相对地址（upload/…），统一补全成绝对地址
  const content = data.content.replace(
    /(src|href)=(["'])(?!https?:\/\/|data:|\/\/)([^"']+)\2/gi,
    (_all: string, attr: string, quote: string, value: string) =>
      `${attr}=${quote}${ctx.parser.resolveUrl(value, finalUrl)}${quote}`,
  )

  const authorLine = ctx.parser.cleanText(data.authorLine)
  return {
    title,
    author: authorLine.replace(/更新时间[\s\S]*$/, '').trim(),
    articleTime: extractTime(authorLine),
    content,
  }
}

export default definePlugin({
  config: {
    id: 'cntc-eyxw-news',
    name: '儿艺 · 儿艺新闻',
    type: 'flow',
    version: '1.1.0',
    description: '中国儿童艺术剧院「儿艺新闻」栏目：列表 + 详情全流程解析（兼容微信公众号外链）',
  },

  /** 列表页：入参是分页后的完整地址（首页 / Column-10_2.html …）。 */
  async getList(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`列表页请求失败：HTTP ${response.status}`)

    const doc = ctx.parser.parseHtml(response.text)
    const links: FlowListItem[] = []
    const seen = new Set<string>()

    for (const item of doc.selectAll('ul.article-list-wrapper li.article-item')) {
      const anchor = item.findAll('a[href]')[0]
      const href = anchor?.attr('href')?.trim()
      if (!anchor || !href) continue

      const absolute = ctx.parser.normalizeUrl(ctx.parser.resolveUrl(href, response.finalUrl))
      if (!/^https?:\/\//i.test(absolute) || seen.has(absolute)) continue
      seen.add(absolute)

      const title = ctx.parser.cleanText(
        item.findAll('h5.text-hidden')[0]?.text() || anchor.text(),
      )
      if (!title) continue

      links.push({
        url: absolute,
        title,
        // 列表项日期：div.dir 的 data-date（如 2026/10/23 14:26:45）
        articleTime: ctx.parser.cleanText(item.findAll('div.dir')[0]?.attr('data-date') ?? ''),
      })
    }

    ctx.logger.info(`[儿艺新闻] 列表页解析到 ${links.length} 条链接`)
    return links
  },

  /** 详情页：按 URL 来源选择解析分支，均用 ctx.html2object 按 schema 解析。 */
  async getDetail(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`详情页请求失败：HTTP ${response.status}`)

    if (/mp\.weixin\.qq\.com/i.test(url)) {
      return wechatDetail(response.text, ctx)
    }
    return siteDetail(response.text, ctx, response.finalUrl)
  },
})
