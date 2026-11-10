import {
  DEBUG_SAMPLE_TABLE,
  closeDatabase,
  initDatabase,
  initDebugDatabase,
} from '../../database/index.js'
import { loadConfig } from '../config.js'

const config = loadConfig()
const context = initDatabase({ file: config.databaseFile })
// 调试数据是独立库：建库脚本也把它建好，避免首次启动时少一张表
const debug = initDebugDatabase(config.debugDatabaseFile)
const modelNames = Object.keys(context.models)

console.log(`数据库已就绪：${context.file}`)
console.log(`调试数据库已就绪：${debug.file}（表 ${DEBUG_SAMPLE_TABLE}）`)
console.log(`模型（${modelNames.length}）：${modelNames.join(', ')}`)
console.log(
  `迁移版本：${context.migrations.map((migration) => `${migration.id}:${migration.name}`).join(', ') || '无'}`,
)

closeDatabase()
