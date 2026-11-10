import { serve } from 'h3'
import { closeDatabase, initDatabase } from '../database/index.js'
import { createApp } from './app.js'
import { startBackgroundJobs, stopBackgroundJobs } from './app-runtime.js'
import { loadConfig } from './config.js'
import { createLogger } from './lib/logger.js'

const config = loadConfig()
const logger = createLogger(config.logLevel)

async function main(): Promise<void> {
  const database = initDatabase({ file: config.databaseFile })
  const app = createApp({ config, logger })
  const background = startBackgroundJobs({ scheduler: config.schedulerEnabled })

  const server = serve(app, { port: config.port, hostname: config.host })

  logger.info(`${config.name} v${config.version} 已启动`, {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    database: database.file,
    // 调试库是独立文件：启动时缺失会自动创建，日志里给出实际路径便于排查
    debugDatabase: config.debugDatabaseFile,
    schemaVersion: database.migrations.at(-1)?.id ?? 0,
    recoveredTasks: background.recovery.requeued.length,
    interruptedTasks: background.recovery.failed.length,
    schedules: background.schedules,
  })

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`收到 ${signal}，正在关闭服务`)

    try {
      await stopBackgroundJobs()
      await server.close()
      closeDatabase()
      logger.info('服务已停止')
      process.exit(0)
    } catch (error) {
      logger.error('关闭服务失败', {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  logger.error('服务启动失败', {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  })
  closeDatabase()
  process.exit(1)
})
