/**
 * 内置插件验收。
 *
 * 插件编在服务端里，没有「加载文件」这一步；这里验证的是三件事：
 * 1. 清单本身站得住：id 唯一、实现完整、能力推导正确；
 * 2. 插件真的能干活：对着 fixture 站点抓列表、抓详情、清洗字段；
 * 3. 类型层能拦住写错的插件——`@ts-expect-error` 由 `tsc` 检查，
 *    如果哪天约束松了，`pnpm typecheck` 会直接报「多余的 expect-error」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createParser } from '../../src/core/index.js'
import { createRequestClient, createScopedRequest } from '../../src/request/index.js'
import {
  definePlugin,
  describePlugin,
  pluginSlots,
  validatePluginModule,
  type PluginContext,
} from '../../src/plugin-system/index.js'
import { builtinPlugins } from '../../src/plugins/index.js'
import { startSiteFixture, type SiteFixture } from '../server/helpers/site-fixture.js'

let fixture: SiteFixture
let ctx: PluginContext

beforeAll(async () => {
  fixture = await startSiteFixture()
  const client = createRequestClient({ ssrf: { allowPrivateNetwork: true } })
  ctx = {
    request: createScopedRequest(client, null),
    // 测试里没接浏览器：fetchPage 用 HTTP 抓一次，够验证「插件能拿到页面」
    fetchPage: async (url) => {
      const response = await client.get(url)
      return { html: response.text, finalUrl: response.finalUrl, status: response.status }
    },
    proxy: null,
    mode: 'http',
    parser: createParser(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}, 30_000)

afterAll(async () => {
  await fixture.close()
})

/** 按 id 取内置插件；取不到时让测试直接失败，而不是返回 undefined 一路传下去。 */
function builtin(id: string) {
  const entry = builtinPlugins.find((item) => item.plugin.config.id === id)
  if (!entry) throw new Error(`内置插件 ${id} 不存在`)
  return entry
}

/* -------------------------------------------------------------------------- */
/* 清单                                                                       */
/* -------------------------------------------------------------------------- */

describe('内置插件清单', () => {
  it('id 唯一，且每个插件都通过运行时校验', () => {
    const ids = builtinPlugins.map((item) => item.plugin.config.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of builtinPlugins) {
      expect(validatePluginModule(entry.plugin), `${entry.source} 校验失败`).toBeNull()
    }
  })

  it('source 指向真实源码文件，方便从界面找回代码', () => {
    for (const entry of builtinPlugins) {
      // 允许嵌套目录：src/plugins/examples/xxx.ts
      expect(entry.source).toMatch(/^src\/plugins\/(?:[\w-]+\/)*[\w-]+\.ts$/)
    }
  })

  it('能力由实现的函数推导，不用另外声明', () => {
    const flow = builtin('example-flow-news').plugin
    expect(pluginSlots(flow)).toEqual(['list', 'detail'])
    expect(describePlugin(flow)).toBe('列表 + 详情插件')

    const parser = builtin('example-parser-clean').plugin
    expect(pluginSlots(parser)).toEqual(['list', 'detail'])
    expect(describePlugin(parser)).toBe('解析器（列表 + 详情）')
  })
})

/* -------------------------------------------------------------------------- */
/* 实际执行                                                                   */
/* -------------------------------------------------------------------------- */

describe('demo-fixture：最简单的全流程插件', () => {
  it('列表：按 .news-item 取链接，相对地址补成绝对地址', async () => {
    const plugin = builtin('demo-fixture').plugin
    const links = await plugin.getList!(`${fixture.origin}/news`, ctx)

    // fixture 的列表页有 7 个 .news-item：5 条正常 + 1 条重复 + 1 条 javascript 伪协议
    // 插件本身不做去重（那是引擎的活），所以这里 7 条都在
    expect(links).toHaveLength(7)
    expect(links[0]).toMatchObject({
      url: `${fixture.origin}/article/1`,
      title: '第一篇报道：城市更新',
      articleTime: '2026-01-01 09:00',
    })
    expect(links.map((link) => link.url)).toContain('javascript:void(0)')
  })

  it('详情：返回标题、作者、时间与正文', async () => {
    const plugin = builtin('demo-fixture').plugin
    const article = await plugin.getDetail!(`${fixture.origin}/article/2`, ctx)

    expect(article.title).toBe('第二篇报道：轨道交通')
    expect(article.author).toBe('记者乙')
    expect(article.articleTime).toBe('2026-01-02 10:30')
    expect(article.content).toContain('新线路进入试运行阶段')
  })

  it('页面里没有标题时抛错（错误即表示这一篇解析失败）', async () => {
    const plugin = builtin('demo-fixture').plugin
    await expect(plugin.getDetail!(`${fixture.origin}/`, ctx)).rejects.toThrow('没有 .article-title')
  })

  it('列表页 404 时抛错，错误信息带状态码', async () => {
    const plugin = builtin('demo-fixture').plugin
    await expect(plugin.getList!(`${fixture.origin}/not-found`, ctx)).rejects.toThrow('HTTP 404')
  })
})

describe('example-parser-clean：字段后处理', () => {
  it('parseDetail 清洗空白、补默认作者、统一时间格式', async () => {
    const plugin = builtin('example-parser-clean').plugin
    const fields = await plugin.parseDetail!(
      'http://example.com/a',
      { title: '  标题   带空格 ', author: '', articleTime: '2026/01/02 10:30' },
      ctx,
    )

    expect(fields).toMatchObject({
      title: '标题 带空格',
      author: '佚名',
      articleTime: '2026-01-02 10:30',
    })
  })

  it('parseList 只动 title / summary，其它字段原样保留', async () => {
    const plugin = builtin('example-parser-clean').plugin
    const fields = await plugin.parseList!(
      'http://example.com/a',
      { title: '  a  ', summary: '  b  ', url: 'http://example.com/a', extra: 1 },
      ctx,
    )

    expect(fields).toEqual({ title: 'a', summary: 'b', url: 'http://example.com/a', extra: 1 })
  })
})

/* -------------------------------------------------------------------------- */
/* 类型约束                                                                   */
/* -------------------------------------------------------------------------- */

describe('definePlugin 的类型约束', () => {
  it('合法的两种写法都能通过', () => {
    const flow = definePlugin({
      config: { id: 'ok-flow', name: 'ok', type: 'flow' },
      async getList(url) {
        return [{ url, title: '标题' }]
      },
    })
    expect(flow.config.type).toBe('flow')
  })

  it('写错的东西编译器会拦住', () => {
    // 全流程插件不能写 parseList
    // @ts-expect-error 全流程插件只能用 getList / getDetail
    definePlugin({ config: { id: 'bad-1', name: 'bad', type: 'flow' }, parseList: async (_url, fields) => fields })

    // 两个函数一个都不写等于什么都不做
    // @ts-expect-error 至少要实现 getList 或 getDetail
    definePlugin({ config: { id: 'bad-2', name: 'bad', type: 'flow' } })

    // 列表条目必须有 url
    // @ts-expect-error FlowListItem 的 url 是必填
    definePlugin({
      config: { id: 'bad-3', name: 'bad', type: 'flow' },
      async getList() {
        return [{ title: '没有地址' }]
      },
    })

    // 详情必须给标题
    // @ts-expect-error FlowDetailResult 的 title 是必填
    definePlugin({
      config: { id: 'bad-4', name: 'bad', type: 'flow' },
      async getDetail() {
        return { author: '佚名' }
      },
    })

    // 解析器插件不能写 getList
    // @ts-expect-error 解析器插件只能用 parseList / parseDetail
    definePlugin({ config: { id: 'bad-5', name: 'bad', type: 'parser' }, getList: async () => [] })

    expect(true).toBe(true)
  })

  it('绕过 definePlugin 手写对象时，运行时校验也能挡住', () => {
    expect(
      validatePluginModule({ config: { id: 'x', name: 'x', type: 'flow' } } as never),
    ).toContain('至少要实现')
    expect(
      validatePluginModule({
        config: { id: 'x', name: 'x', type: 'parser' },
        getList: async () => [],
      } as never),
    ).toContain('parseList')
  })
})
