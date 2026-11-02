import { H3, setHeader } from 'h3'
import { createPluginRegistry, type PluginRegistry } from '@webcrawler/plugins'
import { createRequestClient, type RequestClient } from '@webcrawler/request'
import { createAppRuntime, type AppRuntime } from './app-runtime.js'
import { loadConfig, type AppConfig } from './config.js'
import { MethodNotAllowedError, NotFoundError } from './errors.js'
import { createLogger, type Logger } from './lib/logger.js'
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
import { scheduleRoutes } from './routes/schedules.js'
import { pluginRoutes } from './routes/plugins.js'
import { refreshPlugins } from './services/plugin-service.js'
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

  app.use(createErrorHandler(logger, isProduction))
  app.use(createRequestLogger(logger))
  app.use(createCorsMiddleware(config.corsOrigins))

  const runtime = options.runtime ?? createAppRuntime({ config, request, logger })

  // 让设置服务拿到真实配置作为默认值，并把已保存的设置作用到运行时：
  // 进程重启后并发、限速、日志级别、时区等仍然保持上次保存的值。
  setSettingDefaults(config)
  applySettings(readSettings(), { runtime: runtime.tasks, logger, config })

  // 启动时按数据库里的启用状态重建注册表。
  // 不重建的话，进程重启后注册表是空的，所有插件都会被误判成「加载失败」。
  refreshPlugins(registry)

  const serviceDeps = {
    request,
    allowPrivateNetwork: config.allowPrivateNetwork,
    runtime: runtime.tasks,
    scheduler: runtime.scheduler,
    logger,
    config,
  }

  const routes: ApiRoute[] = [
    ...healthRoutes(config),
    ...systemRoutes(config, registry),
    ...siteRoutes(serviceDeps),
    ...categoryRoutes(serviceDeps),
    ...ruleRoutes(serviceDeps),
    ...testerRoutes(serviceDeps),
    ...taskRoutes(serviceDeps),
    ...articleRoutes(serviceDeps),
    ...logRoutes(serviceDeps),
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
