/**
 * 示例内置插件 · 全流程（列表 + 详情）
 *
 * 和 `demo-fixture` 的区别只在于「多做一点事」：补绝对地址、规范化 URL、
 * 按 URL 去重，给的是可以直接上生产的写法。
 *
 * 全流程插件自己抓页面、自己解析：规则里只填分页方式，不用写任何抽取规则。
 * 两个函数可以只写一个——只写 `getList` 就只出现在列表插件下拉里。
 */
import { definePlugin, type FlowListItem } from '../../plugin-system/sdk.js'

export default definePlugin({
  config: {
    id: 'example-flow-news',
    name: '示例 · 全流程站点',
    type: 'flow',
    version: '1.0.0',
    description: '演示 getList / getDetail：抓页面 + 解析都由插件完成，规则里只填分页方式',
  },

  /** 列表页：入参是分页后的完整地址（如 https://example.com/news?page=2）。 */
  async getList(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`列表页请求失败：HTTP ${response.status}`)

    const doc = ctx.parser.parseHtml(response.text)
    const links: FlowListItem[] = []
    const seen = new Set<string>()

    for (const item of doc.selectAll('.news-item')) {
      const anchor = item.findAll('a.title')[0]
      const href = anchor?.attr('href')?.trim()
      if (!anchor || !href) continue

      // 先补成绝对地址再规范化：去掉 utm 之类的跟踪参数，同一篇文章才会被识别成同一条
      const absolute = ctx.parser.normalizeUrl(ctx.parser.resolveUrl(href, response.finalUrl))
      if (!/^https?:\/\//i.test(absolute) || seen.has(absolute)) continue
      seen.add(absolute)

      const cover = item.findAll('img.thumb')[0]
      links.push({
        url: absolute,
        title: ctx.parser.cleanText(anchor.text()),
        summary: ctx.parser.cleanText(item.findAll('.summary')[0]?.text() ?? ''),
        coverUrl: cover?.attr('data-src') || cover?.attr('src') || '',
      })
    }

    ctx.logger.info(`列表页解析到 ${links.length} 条链接`)
    return links
  },

  /** 详情页：入参是文章地址，返回字段对象。 */
  async getDetail(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`详情页请求失败：HTTP ${response.status}`)

    const doc = ctx.parser.parseHtml(response.text)
    const text = (selector: string) => ctx.parser.cleanText(doc.selectFirst(selector)?.text() ?? '')

    const title = text('.article-title')
    // 标题拿不到就别入库：引擎会把它当作「这一篇解析失败」
    if (!title) throw new Error('详情页没有解析到标题')

    return {
      title,
      author: text('.author'),
      articleTime: text('.publish-time'),
      summary: text('.article-summary'),
      content: doc.selectFirst('.article-content')?.html() ?? '',
      coverUrl: doc.selectFirst('.article-cover')?.attr('src') ?? '',
    }
  },
})
