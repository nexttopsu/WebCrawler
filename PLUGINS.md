# 插件开发指南

一句话：**插件是服务端源码的一部分**。在 `apps/server/src/plugins/` 下新建一个 `.ts` 文件，用 `definePlugin` 定义并 `export default`，重启服务就能用——**不用在任何地方登记**，服务端启动时会自动扫描目录。

- 适用版本：核心 `0.7.x`（`PLUGINS_PACKAGE.version = 0.7.0`）
- 相关源码：
  - `apps/server/src/plugin-system/sdk.ts` — 编写入口 `definePlugin` 与类型约束
  - `apps/server/src/plugin-system/types.ts` — 契约与返回结构
  - `apps/server/src/plugins/` — 内置插件实现（可自由建子目录）
  - `apps/server/src/plugins/index.ts` — 启动时递归扫描、自动汇总清单
  - `apps/server/src/server/services/plugin-service.ts` — 启动注册与启停
  - `apps/server/src/core/engine.ts` — 引擎接入
- 现成示例：[`demo-fixture.ts`](apps/server/src/plugins/demo-fixture.ts)（最简）、[`examples/example-flow-news.ts`](apps/server/src/plugins/examples/example-flow-news.ts)（全流程）、[`examples/example-parser-clean.ts`](apps/server/src/plugins/examples/example-parser-clean.ts)（解析器）

---

## 1. 三分钟写第一个插件

新建 `apps/server/src/plugins/my-site.ts`：

```ts
import { definePlugin, type FlowListItem } from '../plugin-system/sdk.js'

export default definePlugin({
  config: {
    id: 'my-site',          // 规则里引用这个 id，改动会断掉已有规则
    name: '我的站点',
    type: 'flow',
    version: '1.0.0',
    description: '演示站点',
  },

  async getList(url, ctx) {
    const response = await ctx.request.get(url)
    if (!response.ok) throw new Error(`列表页打不开：HTTP ${response.status}`)

    const doc = ctx.parser.parseHtml(response.text)
    const links: FlowListItem[] = []
    for (const item of doc.selectAll('.item')) {
      const anchor = item.selectFirst('a')
      const href = anchor?.attr('href')
      if (!anchor || !href) continue
      links.push({
        url: ctx.parser.resolveUrl(href, response.finalUrl),
        title: ctx.parser.cleanText(anchor.text()),
      })
    }
    return links
  },

  async getDetail(url, ctx) {
    const response = await ctx.request.get(url)
    const doc = ctx.parser.parseHtml(response.text)
    const title = ctx.parser.cleanText(doc.selectFirst('h1')?.text() ?? '')
    if (!title) throw new Error('没有解析到标题')
    return { title, content: doc.selectFirst('.content')?.html() ?? '' }
  },
})
```

**不用再改任何文件**：`src/plugins/index.ts` 在模块加载时递归扫描同目录，
把所有 `export default` 的插件收进清单，进程启动时注册一次。

重启服务，规则测试器里就能选到它。编辑过程中，`ctx`、返回值都有补全。

### 目录约定

```
apps/server/src/plugins/
├── index.ts                    # 汇总入口：自动扫描，永远不用编辑它
├── demo-fixture.ts             # 平铺
└── examples/                   # 可以任意套目录
    ├── example-flow-news.ts
    └── example-parser-clean.ts
```

- **可嵌套**：`news/site-a.ts`、`news/site-a/list.ts` 都行，层级不限，按业务/站点分组更清楚；
- **`_` 与 `.` 开头会被跳过**：`_shared.ts` 这类工具模块放在同目录不会报错；
- **`index.ts` 是入口**，不会被当成插件；子目录里的 `index.ts` 仍可以是插件；
- **隐藏文件、`*.d.ts`、`node_modules`** 自动忽略；
- 加载顺序按路径排序，日志和界面里的先后是稳定的。

---

## 2. 两种插件，四个函数

| 类型 | `config.type` | 可实现的函数 | 职责 |
| --- | --- | --- | --- |
| 全流程 | `flow` | `getList(url, ctx)` / `getDetail(url, ctx)` | 自己抓页面、自己解析，规则里**只填分页方式** |
| 解析器 | `parser` | `parseList(url, fields, ctx)` / `parseDetail(url, fields, ctx)` | 平台已抽好字段，插件做二次处理 |

- **两个函数可以只写任意一个**：只写 `getList` 就只出现在「列表插件」下拉里，只写 `getDetail` 就只出现在「详情插件」下拉里。
- 能力不用声明，由实现的函数推导（`pluginSlots()`），不存在「声明了但没实现」的错配。
- 类型与函数必须匹配：`flow` 里写 `parseList`、`parser` 里写 `getList`，编译期就报错。

---

## 3. 返回值结构

类型定义在 `plugin-system/types.ts`，`definePlugin` 会按它检查你的返回值。

**`getList` → `FlowListItem[]`**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | ✅ | 文章地址。相对地址请用 `ctx.parser.resolveUrl()` 补全；非 `http(s)` 的条目会被引擎丢弃 |
| `title` `author` `summary` `content` `coverUrl` `articleTime` | | 列表阶段就能拿到的字段，入库时直接用 |
| `extra` | | 自定义字段，入库进 `extra` |

**`getDetail` → `FlowDetailResult`**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 拿不到标题就 `throw`，引擎会把这一篇记为失败，而不是塞一条空标题进库 |
| `url` | | 页面里抽到的规范地址；省略时用列表链接的地址（推荐省略，否则同 URL 去重会失效） |
| 其余同上 | | |

**`parseList` / `parseDetail` → `ArticleFields`（`Record<string, unknown>`）**

拿到的是 `url` + 当前字段对象，返回的对象**直接用于保存**。不想改就原样 `return fields`。

---

## 4. `ctx` 提供什么

| 能力 | 说明 |
| --- | --- |
| `ctx.request` | 平台请求器（`get` / `post` / `getText` / `getJson`）。**纯 HTTP，不执行 JS**；已绑定本次运行的代理，SSRF 校验、重定向、超时、响应体上限由平台处理。单次请求传 `{ proxy: null }` 可强制直连。**不要自己造 HTTP 客户端** |
| `ctx.fetchPage(url)` | 按本次运行的模式抓页面：`browser` 模式走浏览器渲染，返回 `{ html, finalUrl, status }`。与引擎内部抓取同一条路径（代理 / SSRF / 超时一致），所以插件不需要（也不该）自己 launch 浏览器 |
| `ctx.proxy` / `ctx.mode` | 本次运行使用的代理与模式，只读。测试器里选的 Browser / 代理会原样传进来 |
| `ctx.parser` | `parseHtml` / `selectAll` / `selectFirst` / `cleanText` / `htmlToText` / `cleanHtml` / `resolveUrl` / `normalizeUrl` / `extractImages` |
| `ctx.html2object(html, schema, removeSelector?)` | request-pack 的整页解析器：按 schema 一次把 HTML 解析成结构化对象，**返回类型自动推导**。与 `ctx.schema` 搭配使用，插件里不用再 import request-pack |
| `ctx.schema` | `html2object` 的字段构造器：`text` / `html` / `attr` / `json`（解析 JSON-LD）/ `loop`（列表）/ `object`（嵌套）/ `nullable`（未匹配返回 null），写页面解析配置全在这里拼 |
| `ctx.site` / `ctx.category` | 本次运行的站点与栏目快照（`id` / `name` / `domain` / `baseUrl`；栏目含 `listUrl`），只读 |
| `ctx.rule` | 本次运行的**生效规则**快照：`{ id?, version, config }`，`config` 是「站点默认 < 栏目 < 任务覆盖」合并后的完整规则，插件可以按它读取字段配置、分页方式等 |
| `ctx.requestOptions` | 本次运行的请求级配置（超时 / 请求头 / 编码 / 重试等），只读 |
| `ctx.logger` | `info` / `warn` / `error`，写入任务日志（不要用 `console`） |
| `ctx.siteId` / `ctx.categoryId` | 当前站点与栏目 id（便捷访问，同 `ctx.site.id` / `ctx.category.id`） |

几个容易踩的点：

- **`ctx.request` 吃不到浏览器**：它在任何模式下都是 HTTP。页面靠 JS 渲染（SPA、无限滚动）时必须用 `ctx.fetchPage`，否则拿到的只是空壳 HTML。
- **`ctx.request` 走代理，但不受任务限速约束**：`IntervalLimiter` 只管「每篇文章之间」的间隔，插件在 `getList` 里循环发一百个请求不会被它拦住，需要自己控制节奏。
- **重试默认关闭**：`ctx.request.get(url)` 的 `retries` 默认 0，需要重试时显式传 `{ retries: 2 }`。

`ctx.html2object` + `ctx.schema` 的典型用法——整页解析一次完成，替代一串 `selectFirst`：

```ts
async getDetail(url, ctx) {
  const response = await ctx.request.get(url)
  const data = ctx.html2object(response.text, {
    title: ctx.schema.text('.detail-wrapper h3.title'),
    author: ctx.schema.nullable(ctx.schema.text('.author')),
    content: ctx.schema.html('.context'),
    tags: ctx.schema.loop('.tag', ctx.schema.text('')),
  })
  if (!data.title) throw new Error('没有解析到标题')
  return { title: data.title, author: data.author ?? '', content: data.content, extra: { tags: data.tags } }
}
```

需要第三方包时直接 `pnpm add <pkg> --filter @webcrawler/server`，在插件里正常 `import`——插件和服务端同一个编译单元，不存在模块解析问题。但**解析 HTML、发请求这两件事优先用 `ctx` 提供的能力**，重复引一份 `cheerio` 只会让构建变重。

---

## 5. 类型约束能拦住什么

`definePlugin` 的入参类型会做这些检查（`test/plugin-system/builtin.test.ts` 里有对应的 `@ts-expect-error` 用例）：

| 写法 | 结果 |
| --- | --- |
| `type: 'flow'` + `getList` | ✅ |
| `type: 'flow'` + `parseList` | ❌ 全流程插件只能用 getList / getDetail |
| 两个函数都不写 | ❌ 至少要实现一个 |
| `getList` 返回 `[{ title }]` | ❌ 缺少必填的 `url` |
| `getDetail` 返回 `{ author }` | ❌ 缺少必填的 `title` |
| `type: 'parser'` + `getList` | ❌ 解析器插件只能用 parseList / parseDetail |

运行时还有一层兜底（`validatePluginModule`），挡住绕过 `definePlugin` 手写对象的情况。

---

## 6. 注册、启停与生效时机

- **只在启动时注册一次**：`src/plugins/index.ts` 在模块加载时递归扫描目录（顶层 await），`createApp()` 再把清单写进内存注册表。运行期不扫描目录、不重读文件。
- **数据库只存开关**：`plugin` 表只有 `pluginId + enabled`。名称、类型、支持位置、源码位置全部来自代码，不存在「库里和代码对不上」。
- **改代码 → 重启服务**。`pnpm dev` 的 tsx watch 会自动重启。
- **启停立即生效**：插件模块已在内存里，停用 = 从注册表移除，启用 = 写回注册表，同时落库，重启后保持。
- 单个插件实现有问题只影响它自己：写日志、界面标成「实现有问题」，其它插件照常工作。

---

## 7. 调试

1. **规则测试器**（`/tester`）：列表页签选「列表插件」、详情页签选「详情插件」，填地址直接跑，结果里能看到每条链接、每个字段。
2. **插件管理**（`/plugins`）：看支持位置与源码位置，出错时在详情抽屉里查错误日志。
3. **任务日志**（`/logs`）：`stage=plugin` 的记录就是插件在真实采集里的输出。

调试技巧：在插件里 `ctx.logger.info(...)` 打点，比 `console.log` 更容易在日志页里过滤。

---

## 8. 常见问题

**Q：能不能放一个 `.js` 插件到某个目录，让服务端自动加载？**
只能放在 `src/plugins/` 下的任意子目录，跟着服务端一起编译；运行时不会读取仓库外的目录。这是有意的取舍：换来完整类型、第三方依赖、构建期检查，代价是新增插件要重新构建/重启。

**Q：插件能不能单独发布 / 热更新？**
不能。插件与服务端同版本编译，`config.version` 只是展示用的标签。需要跨项目复用时，把解析逻辑抽成普通模块，由插件 `import`。

**Q：为什么没有「扫描」「重建注册表」按钮了？**
插件是代码，不是运行时资源。`src/plugins/index.ts` 在模块加载时自动扫描目录并缓存结果，重启即生效；界面上那层「登记表」已经删掉，只剩启用开关。

**Q：新加的插件没出现在列表里？**
看日志里 `stage=plugin` 的错误：常见原因是文件没有 `export default definePlugin(...)`、`config.type` 与实现的函数不匹配、或 `config.id` 与已有插件重复。单个文件出错不影响其它插件，修好后重启即可。
