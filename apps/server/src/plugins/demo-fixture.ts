/**
 * 最简内置插件 · 本地 fixture 站点
 * ---------------------------------------------------------------------------
 * 这个文件是用来「看效果」和「抄结构」的：不写去重、不写容错分支，
 * 只保留一个插件最少需要的东西。
 *
 * 三个地方值得注意：
 * 1. 配置与函数写在同一个对象里，交给 `definePlugin` —— 返回值结构和 type 由编译器检查；
 * 2. `ctx` 里的 `request` / `parser` 都是平台注入的，编辑器有完整补全，不用自己引依赖；
 * 3. 两个函数可以删掉任意一个，删掉后这个插件就只出现在对应阶段的下拉框里。
 *
 * 怎么用：启动 `pnpm fixture`（本地站点 4100）与 `pnpm dev`，
 * 规则测试器 → 列表插件选它 → 地址填 http://127.0.0.1:4100/news。
 */
import { definePlugin, type FlowListItem } from '../plugin-system/sdk.js'

export default definePlugin({
  config: {
    id: 'demo-fixture',
    name: '演示 · 本地 Fixture',
    type: 'flow',
    version: '1.0.0',
    description: '最简单的内置插件：只认 fixture 站点的结构，用来在规则测试器里看效果',
  },

  /** 列表：入参是分页后的完整地址，返回条目数组。 */
  async getList(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`列表页打不开：HTTP ${response.status}`)

    const doc = ctx.parser.parseHtml(response.text)
    const links: FlowListItem[] = []

    for (const item of doc.selectAll('.news-item')) {
      const anchor = item.findAll('a.title')[0]
      const href = anchor?.attr('href')
      if (!anchor || !href) continue // javascript:void(0) 这类无效链接在这里就被跳过

      links.push({
        // 相对地址补全交给平台，响应过重定向时以 finalUrl 为准
        url: ctx.parser.resolveUrl(href, response.finalUrl),
        title: ctx.parser.cleanText(anchor.text()),
        articleTime: ctx.parser.cleanText(item.findAll('.time')[0]?.text() ?? ''),
      })
    }

    ctx.logger.info(`解析到 ${links.length} 条链接`)
    return links
  },

  /** 详情：入参是文章地址，返回一篇文章。url 由列表链接决定，这里不用返回。 */
  async getDetail(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`详情页打不开：HTTP ${response.status}`)

    const doc = ctx.parser.parseHtml(response.text)
    const text = (selector: string) => ctx.parser.cleanText(doc.selectFirst(selector)?.text() ?? '')

    const title = text('.article-title')
    // 结构上 title 是必填的；这里再挡一次空值，免得往库里塞没标题的脏数据
    if (!title) throw new Error('页面里没有 .article-title，可能不是文章页')

    return {
      title,
      author: text('.author'),
      articleTime: text('.publish-time'),
      content: doc.selectFirst('.article-content')?.html() ?? '',
    }
  },
})
