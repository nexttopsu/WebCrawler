import { H3, setHeader } from 'h3'
import { initDebugDatabase } from '../database/index.js'
import { createPluginRegistry, type PluginRegistry } from '../plugin-system/index.js'
import { createRequestClient, type RequestClient } from '../request/index.js'
import { createAppRuntime, type AppRuntime } from './app-runtime.js'
import { loadConfig, type AppConfig } from './config.js'
import { MethodNotAllowedError, NotFoundError } from './errors.js'
import { createLogger, type Logger } from './lib/logger.js'
import { createResourcesHandler } from './lib/resources.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { createRequestLogger } from './middleware/request-logger.js'
import { healthRoutes } from './routes/health.js'
import { systemRoutes } from './routes/system.js'
import { siteRoutes } from './routes/sites.js'
import { categoryRoutes } from './routes/categories.js'
import { ruleRoutes } from './routes/rules.js'
import { testerRoutes } from './routes/tester.js'
import { proxyRoutes } from './routes/proxies.js'
import { taskRoutes } from './routes/tasks.js'
import { articleRoutes } from './routes/articles.js'
import { logRoutes } from './routes/logs.js'
import { debugDataRoutes } from './routes/debug-data.js'
import { openRoutes } from './routes/open.js'
import { scheduleRoutes } from './routes/schedules.js'
import { pluginRoutes } from './routes/plugins.js'
import { registerBuiltinPlugins } from './services/plugin-service.js'
import { settingRoutes } from './routes/settings.js'
import { statsRoutes } from './routes/stats.js'
import { applySettings, readSettings, setSettingDefaults } from './services/settings-service.js'
import type { ApiRoute } from './routes/types.js'

export interface CreateAppOptions {
  /** 不传时从环境变量读取 */
  config?: AppConfig
  /** 不传时创建空注册表 */
  plugins?: PluginRegistry
  /** 不传时按 config.logLevel 创建 */
  logger?: Logger
  /** 不传时按 config 创建；测试可注入自定义客户端 */
  request?: RequestClient
  /** 不传时创建新的任务运行时；测试可复用同一实例等待任务结束 */
  runtime?: AppRuntime
}

/**
 * 把声明式路由路径转成正则，用于兜底路由判断 404 / 405。
 *
 * 路径中的 `:id` 这类参数段按「非斜杠的一段」匹配；
 * 静态段先整体转义，避免 `.` 等字符被当成正则元字符。
 */
function toPathMatcher(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withParams = escaped.replace(/:([A-Za-z0-9_]+)/g, '[^/]+')
  return new RegExp(`^${withParams}$`)
}

/**
 * 组装 H3 应用。
 *
 * 中间件顺序即执行顺序：错误处理在最外层，保证后续任何环节抛出的异常
 * 都能转成统一响应；随后是访问日志与 CORS。
 *
 * 路由以声明式表集中注册，兜底路由据此区分 404 与 405。
 */
export function createApp(options: CreateAppOptions = {}): H3 {
  const config = options.config ?? loadConfig()
  const logger = options.logger ?? createLogger(config.logLevel)
  const registry = options.plugins ?? createPluginRegistry()
  const isProduction = config.env === 'production'

  const request =
    options.request ??
    createRequestClient({
      ssrf: { allowPrivateNetwork: config.allowPrivateNetwork },
    })

  const app = new H3({ debug: !isProduction })

  // 调试数据是独立库（默认 data/debug.db）：这里只负责打开连接与建表，
  // 采集 / 测试命中与否由引擎通过 debug-data-service 查询。
  initDebugDatabase(config.debugDatabaseFile)

  app.use(createErrorHandler(logger, isProduction))
  app.use(createRequestLogger(logger))
  app.use(createCorsMiddleware(config.corsOrigins))

  const runtime = options.runtime ?? createAppRuntime({ config, request, logger, pluginRegistry: registry })

  // 让设置服务拿到真实配置作为默认值，并把已保存的设置作用到运行时：
  // 进程重启后并发、限速、日志级别、时区等仍然保持上次保存的值。
  setSettingDefaults(config)
  applySettings(readSettings(), { runtime: runtime.tasks, logger, config })

  // 启动时注册内置插件：`src/plugins/index.ts` 在模块加载时已递归扫描完目录，
  // 这里只是把清单一次性写进注册表。运行期不再扫描目录或重读文件，改插件代码需重启服务。
  // 外部注入注册表时（测试）由调用方决定注册什么，这里不覆盖。
  if (!options.plugins) registerBuiltinPlugins(registry)

  const serviceDeps = {
    request,
    allowPrivateNetwork: config.allowPrivateNetwork,
    pluginRegistry: registry,
    runtime: runtime.tasks,
    scheduler: runtime.scheduler,
    logger,
    config,
  }

  const routes: ApiRoute[] = [
    ...healthRoutes(config),
    ...systemRoutes(config, registry),
    // 对外开放的只读接口：独立前缀，全部是 GET
    ...openRoutes(),
    ...siteRoutes(serviceDeps),
    ...categoryRoutes(serviceDeps),
    ...ruleRoutes(serviceDeps),
    ...testerRoutes(serviceDeps),
    ...taskRoutes(serviceDeps),
    ...articleRoutes(serviceDeps),
    ...logRoutes(serviceDeps),
    ...debugDataRoutes(serviceDeps),
    ...scheduleRoutes(serviceDeps),
    ...proxyRoutes(serviceDeps),
    ...pluginRoutes(serviceDeps, registry),
    ...settingRoutes(serviceDeps),
    ...statsRoutes(),
  ]

  const matchers = routes.map((route) => ({ method: route.method, regex: toPathMatcher(route.path) }))
  for (const route of routes) {
    app.on(route.method, route.path, route.handler)
  }

  // 静态资源：仓库根 resources/ 目录（采集下载的缩略图等），必须注册在兜底路由之前。
  // 用 all 注册让 HEAD 也能命中；GET/HEAD 之外的请求由 serveStatic 抛 405。
  app.all('/resources/**', createResourcesHandler())

  // 兜底路由：保证未匹配的地址也返回统一结构
  app.all('/**', (event) => {
    const pathname = event.url.pathname
    const allowed = [
      ...new Set(
        matchers.filter((matcher) => matcher.regex.test(pathname)).map((matcher) => matcher.method),
      ),
    ]

    if (allowed.length > 0) {
      setHeader(event, 'allow', allowed.join(', '))
      throw new MethodNotAllowedError(`该路径仅支持 ${allowed.join(', ')}`)
    }
    throw new NotFoundError('接口不存在')
  })

  return app
}
