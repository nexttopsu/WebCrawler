# 插件开发指南

本文档面向想为 WebCrawler 扩展采集能力的开发者，介绍插件系统的设计原则、数据契约、清单规范、开发流程与管理方式。

- 适用版本：核心 `@webcrawler/plugins` / `@webcrawler/core` `0.6.x`
- 相关源码：`packages/plugins/`（契约与注册表）、`packages/core/`（采集引擎）、`apps/server/src/services/plugin-service.ts`（扫描、启停、登记）
- 管理入口：Web 控制台「插件管理」页，或 `/api/plugins` 系列接口

---

## 1. 设计原则

插件系统刻意做得很窄，只解决一件事：**网站差异**。

- 插件只负责「匹配站点 → 给出列表链接 → 解析详情」；
- HTTP 请求、HTML 解析、正文清洗、数据校验全部由 `@webcrawler/core` 的采集引擎（`CrawlEngine`）提供；
- 插件**不得**直接访问数据库，**不得**自行创建 HTTP 客户端或 Playwright 实例；
- 代理、超时、取消信号、日志都由引擎通过 `CrawlContext` 注入，插件只消费；
- 服务端**不联网安装第三方包、不做插件市场**，只做本地目录扫描 + 清单登记 + 启停。

绝大多数网站**不需要写插件**：内置的通用站点插件（`GenericSitePlugin`）是配置驱动的，只要站点规则里有 `list` / `detail.fields`，它就能完成采集。什么时候才需要写代码插件？——站点有特殊交互（登录、接口签名、动态翻页协议等），通用规则引擎表达不了的时候。

---

## 2. 插件类型

| 类型 | 值 | 职责 | 当前状态 |
| --- | --- | --- | --- |
| 数据源 | `source` | 站点匹配 + 列表链接提取 + 详情解析 | 已实现（`SitePlugin` 契约 + 内置通用插件） |
| 解析器 | `parser` | 从 HTML 中提取结构化数据 | 预留 |
| 导出器 | `exporter` | 把文章写入外部系统 | 预留 |
| 生命周期钩子 | `hook` | 任务前后的自定义逻辑 | 预留 |

> 目前只有 `source` 类型有运行时契约（`SitePlugin`）。`parser` / `exporter` / `hook` 可以先登记清单占位，但引擎不会调用它们。

---

## 3. 插件目录与清单

### 3.1 目录布局

服务端从 **插件目录**（`PLUGIN_DIR` 环境变量，默认 `<进程工作目录>/plugins`）扫描**一层子目录**，每个子目录里放一份 `plugin.json`：

```text
plugins/
└── my-site-plugin/
    ├── plugin.json      ← 清单（必须）
    └── index.js         ← 插件代码（当前版本见 §6「运行边界」）
```

- 目录不存在时视为「没有本地插件」，扫描不报错；
- 只有直接子目录会被扫描，不会递归；
- 单个清单非法**不影响**其它插件，失败项逐条返回。

### 3.2 plugin.json 规范

```json
{
  "name": "my-site-plugin",
  "version": "1.0.0",
  "type": "source",
  "entry": "index.js",
  "description": "XX 门户专用采集插件",
  "coreVersion": "^0.6.0",
  "config": { "domains": ["example.com"] }
}
```

字段校验规则（与服务端一致）：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `name` | ✅ | 2–64 字符，`^[A-Za-z0-9][A-Za-z0-9._-]*$`，全局唯一（重复名会被跳过） |
| `version` | ✅ | 形如 `1.0.0` |
| `type` | ✅ | `source` / `parser` / `exporter` / `hook` |
| `entry` | — | 入口文件相对路径，≤200 字符，仅做登记 |
| `description` | — | ≤200 字符 |
| `coreVersion` | — | 兼容的核心版本范围；不兼容时**自动禁用**并记录原因 |
| `config` | — | 任意 JSON 对象，API 返回时会做敏感值脱敏 |

`coreVersion` 支持 `*`、精确版本、`^`、`~`、`>=`、`>`、`<=`、`<` 及 `||` 组合，例如 `"^0.6.0"`、`">=0.5.0 <1.0.0"`、`"^0.5.0 || ^0.6.0"`。

---

## 4. 核心契约

契约全部定义在 `packages/plugins/src/types.ts`，从 `@webcrawler/plugins` 导入。

### 4.1 CrawlerPlugin（所有插件的基座）

```ts
interface CrawlerPlugin {
  readonly name: string
  readonly version: string
  readonly type: PluginType
  /** 注入能力（请求、解析、浏览器）；在这里保存引用，不要自己 new 客户端 */
  initialize(services: CrawlServices): void | Promise<void>
  destroy(): void | Promise<void>
}
```

`CrawlServices` 来自 `@webcrawler/core`：

```ts
interface CrawlServices {
  request: RequestClient        // 统一请求层（含代理、重试、编码、SSRF 防护）
  parser: Parser                // CSS / XPath / JSONPath 解析器
  browser: BrowserClient | null // Playwright 客户端；未启用时为 null
}
```

### 4.2 SitePlugin（数据源插件）

```ts
interface SitePlugin extends CrawlerPlugin {
  /** 判断该插件是否负责这个地址 */
  match(url: string): boolean
  /** 提取列表页中的文章链接 */
  getList(context: CrawlContext): Promise<ArticleLink[]>
  /** 解析详情页；link 省略时使用 context.url */
  parseDetail(context: CrawlContext, link?: ArticleLink): Promise<ArticleData>
}
```

注册表按 `listPlugins()` 的名称顺序调用 `match()`，**第一个匹配的插件**负责该地址。

### 4.3 CrawlContext（运行时上下文）

```ts
interface CrawlContext {
  site: SiteSnapshot          // id / name / domain / baseUrl / pluginName
  category: CategorySnapshot  // 栏目 id / name / listUrl
  rule: RuleSnapshot          // 该栏目绑定的采集规则（config: CrawlRuleConfig）
  url: string                 // 当前处理的地址（列表页或详情页）
  requestOptions: CrawlRequestOptions
  proxy: ProxySettings | null // 生效代理；null = 直连
  signal: AbortSignal         // 任务取消信号，贯穿请求与解析
  logger: CrawlLogger         // debug/info/warn/error，写入 crawl_log
  metadata: Record<string, unknown>  // 例如 { taskId }
}
```

### 4.4 数据结构

**列表线索 `ArticleLink`**：`{ title?, url, sourceUrl, metadata? }`——`url` 必须是绝对地址。

**详情结果 `ArticleData`**（你的插件最终要产出它）：

```ts
{
  siteId: string; categoryId: string;
  title: string; url: string;
  author?: string; publishTime?: string;
  content?: string;   // 纯文本正文
  html?: string;      // 清洗后的正文 HTML
  images: string[];   // 正文图片绝对地址，按出现顺序去重
  contentHash?: string;
  crawlTime: string;  // ISO 8601
  metadata?: Record<string, unknown>;
}
```

### 4.5 错误处理

插件内部异常应包装为 `PluginError`，错误码四选一：

| 错误码 | 含义 |
| --- | --- |
| `NOT_INITIALIZED` | 未 `initialize` 就调用了能力 |
| `NOT_MATCHED` | 该地址不属于本插件 |
| `EXECUTION_FAILED` | 执行失败（规则缺失、选择器非法、网络异常等） |
| `VALIDATION_FAILED` | 抓到的数据未通过校验 |

---

## 5. 编写一个站点插件

### 5.1 推荐写法：委托给引擎

除非万不得已，不要自己写请求和解析——用 `CrawlEngine` 复用整条链路（请求 → 解析 → 清洗 → 校验），保证插件采集与「规则测试器」行为一致。下面的示例在通用逻辑之外增加站点特殊处理（比如先调登录接口拿 Cookie）：

```ts
// plugins/my-site-plugin/index.ts
import { CrawlEngine, type CrawlServices } from '@webcrawler/core'
import type { HttpResponse, RequestClient } from '@webcrawler/request'
import {
  PluginError,
  PluginErrorCode,
  type ArticleData,
  type ArticleLink,
  type CrawlContext,
  type SitePlugin,
} from '@webcrawler/plugins'

export class MySitePlugin implements SitePlugin {
  readonly name = 'my-site-plugin'
  readonly version = '1.0.0'
  readonly type = 'source' as const

  private engine: CrawlEngine | null = null
  private request: RequestClient | null = null
  private cookie = ''

  /** 注入能力：保存引用即可，不要自己 new 客户端 */
  initialize(services: CrawlServices): void {
    this.engine = new CrawlEngine(services)
    this.request = services.request
  }

  destroy(): void {
    this.engine = null
    this.request = null
    this.cookie = ''
  }

  /** 只负责 example.com（含子域名） */
  match(url: string): boolean {
    try {
      return /(^|\.)example\.com$/.test(new URL(url).hostname)
    } catch {
      return false
    }
  }

  /** 列表页：站点特殊逻辑 + 引擎通用提取 */
  async getList(context: CrawlContext): Promise<ArticleLink[]> {
    const engine = this.requireEngine()
    try {
      await this.ensureSession(context)
      return await engine.listLinks(context)
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw this.wrap(error, 'list')
    }
  }

  /** 详情页：委托引擎按规则解析并校验 */
  async parseDetail(context: CrawlContext, link?: ArticleLink): Promise<ArticleData> {
    const engine = this.requireEngine()
    const target = link ?? { url: context.url, sourceUrl: context.url }
    try {
      const result = await engine.parseDetail(context, target)
      if (!result.article) {
        throw new PluginError(
          this.name,
          PluginErrorCode.VALIDATION_FAILED,
          result.errors.join('；') || '数据校验未通过',
          { missing: result.missing },
        )
      }
      return result.article
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw this.wrap(error, 'detail')
    }
  }

  /** 站点特殊逻辑示例：登录换会话 Cookie（必须走统一请求层，并响应取消信号） */
  private async ensureSession(context: CrawlContext): Promise<void> {
    if (this.cookie) return
    const client = this.requireRequest()
    const response: HttpResponse = await client.request({
      url: 'https://passport.example.com/api/login',
      method: 'POST',
      body: { username: 'bot', password: '***' },
      signal: context.signal,
      timeoutMs: 10_000,
    })
    if (!response.ok) {
      throw new PluginError(this.name, PluginErrorCode.EXECUTION_FAILED, `登录失败：HTTP ${response.status}`)
    }
    this.cookie = response.setCookies.join('; ')
    context.logger.info('站点会话已刷新', { stage: 'plugin' })
  }

  private requireEngine(): CrawlEngine {
    if (!this.engine) {
      throw new PluginError(this.name, PluginErrorCode.NOT_INITIALIZED, '插件尚未初始化')
    }
    return this.engine
  }

  private requireRequest(): RequestClient {
    if (!this.request) {
      throw new PluginError(this.name, PluginErrorCode.NOT_INITIALIZED, '插件尚未初始化')
    }
    return this.request
  }

  private wrap(error: unknown, stage: string): PluginError {
    const message = error instanceof Error ? error.message : String(error)
    return new PluginError(this.name, PluginErrorCode.EXECUTION_FAILED, message, { stage })
  }
}
```

### 5.2 开发期手动注册（不走目录扫描）

注册表暴露了 `registerPlugin()`，可以在代码里直接挂载运行时实例（测试或内嵌使用时的标准方式）：

```ts
import { createPluginRegistry } from '@webcrawler/plugins'
import { createRequestClient } from '@webcrawler/request'
import { createParser, CrawlEngine } from '@webcrawler/core'

const registry = createPluginRegistry()
const plugin = new MySitePlugin()
await plugin.initialize({
  request: createRequestClient({}),
  parser: createParser(),
  browser: null,
})
registry.registerPlugin(plugin)

// 之后即可按地址派发：
const sitePlugin = registry.findSitePlugin('https://www.example.com/news')
```

### 5.3 用 Vitest 验证

参考现成用例：`packages/plugins/test/generic-plugin.test.ts`、`packages/plugins/test/registry.test.ts`。要点：

- `match()` 用真实 URL 字符串断言（含子域名、非法 URL）；
- `getList` / `parseDetail` 用本地 fixture 页面（项目里有 `:4100` fixture 服务的先例）驱动 `CrawlEngine`；
- 断言错误路径：未初始化抛 `NOT_INITIALIZED`，不匹配的地址抛 `NOT_MATCHED`。

运行：

```bash
pnpm --filter @webcrawler/plugins test
```

---

## 6. 运行边界（当前版本须知）

当前版本（0.6.x）插件系统完成的是**清单层**的完整闭环，请务必了解以下边界：

1. **目录扫描只登记清单，不动态 import 代码。** `plugin.json` 的 `entry` 目前仅做登记（落库、展示），服务端不会在运行时加载该文件并调用。
2. **真正参与采集的运行时实例来自代码内置注册。** 引擎采集任务时走 `CrawlEngine` + 规则配置，等价于内置通用站点插件的行为；站点数据上的 `pluginName` 字段已经预留，动态加载器是下一阶段的路线图。
3. **启停语义**：禁用会把插件从注册表移除（清单保留、状态 `disabled`）；启用会校验 `coreVersion`，不兼容直接拒绝。服务重启时按数据库的启用状态重建注册表（`refreshPlugins`），禁用的插件不会被扫描「复活」。
4. **不兼容自动禁用**：扫描或刷新时发现 `coreVersion` 与当前核心版本（0.6.0）不匹配，插件会被自动置为禁用并写错误日志。

因此，现阶段要让自定义采集逻辑生效，有两条路：

- **配置优先**：把站点差异表达成规则（选择器、分页、浏览器模式等），交给通用插件跑——能覆盖 90% 的场景；
- **代码内置**：像 `GenericSitePlugin` 一样把插件放进 `@webcrawler/plugins`（或你的服务端启动代码里）并 `registerPlugin()`，随服务一起构建发布。

---

## 7. 插件管理 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/plugins` | 分页列表，支持 `keyword` / `type` / `enabled` / `status` |
| `GET` | `/api/plugins/:name` | 单个插件详情 |
| `PATCH` | `/api/plugins/:name/status` | 启用/禁用，body `{ "enabled": true }`；空 body 为切换 |
| `GET` | `/api/plugins/:name/errors` | 最近错误日志（最多 100 条） |
| `POST` | `/api/plugins/scan` | 扫描插件目录，body `{ "directory": "..." }` 可覆盖默认目录；扫描后自动按启用状态重建注册表 |
| `POST` | `/api/plugins/refresh` | 重建注册表（清空后按数据库启用状态登记） |

插件状态（`status`）含义：

| 状态 | 含义 |
| --- | --- |
| `enabled` | 已启用且已登记进注册表 |
| `disabled` | 已禁用 |
| `invalid` | 数据库里启用，但注册表里没有（例如重启后加载失败） |
| `incompatible` | 扫描时因核心版本不兼容被拒绝（错误原因见扫描结果与日志） |

---

## 8. 内置通用站点插件速查

`GenericSitePlugin`（`@webcrawler/plugins`）是配置驱动的参考实现，也可直接复用：

```ts
import { createGenericSitePlugin } from '@webcrawler/plugins'

const plugin = createGenericSitePlugin({
  name: 'generic-site',
  version: '0.2.0',
  domains: ['cntc.org.cn'], // 省略则匹配所有站点
})
```

- `match`：域名精确匹配或子域名匹配（自动去掉协议、端口、`www.`）；
- `getList` / `parseDetail`：全部委托 `CrawlEngine`，异常统一包装为 `PluginError`；
- 校验失败（`result.article` 为空）时抛 `VALIDATION_FAILED`，并附带缺失字段信息。

对应的规则结构（`CrawlRuleConfig`）支持：`request`（HTTP/浏览器模式、编码、重试、Cookie 等）、`list`（`itemSelector` / `linkSelector` / `titleSelector` + 分页 `query` / `path` / `next` / `cursor`）、`detail.fields`（`text` / `html` / `attr` / `list` / `object`，CSS / XPath / JSONPath，`clean` 清理与 `required` 校验）、`clean`（移除广告选择器、保留图片）、`validate`（必填字段、最短长度）、`browser`（等待策略、视口、拦截资源）。完整字段见 `packages/shared/src/crawl.ts`。

---

## 9. FAQ

**Q：插件里能发 HTTP 请求吗？**
能，但必须用 `services.request`（或经 `CrawlEngine`），它会统一处理代理、重试、编码、体积上限与 SSRF 防护，并响应 `context.signal` 的取消。自己 `fetch` / `axios` 的后果是：不走代理、不受取消控制、错误无法归因。

**Q：插件能写数据库吗？**
不能。插件产出 `ArticleData`，入库由服务端任务执行器负责。需要导出到外部系统属于 `exporter` 类型（预留中）。

**Q：为什么我的插件状态是 `invalid`？**
数据库里是启用状态，但当前进程注册表里没有它。常见原因：清单非法、核心版本不兼容被自动禁用（看 `/api/plugins/:name/errors`）、或服务重启后未刷新注册表（0.6.x 起 `createApp` 启动时会自动 `refreshPlugins`）。

**Q：怎么确认插件被引擎选中了？**
看任务日志（stage=`plugin` / `request`），或调用 `registry.findSitePlugin(url)` 在代码里验证匹配结果。注册表按名称顺序匹配第一个 `match()` 通过的插件，命名会影响优先级。
