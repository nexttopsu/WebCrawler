import { closeDatabase, initDatabase } from '../../database/index.js'
import { loadConfig } from '../config.js'

const config = loadConfig()
const context = initDatabase({ file: config.databaseFile })
const modelNames = Object.keys(context.models)

console.log(`数据库已就绪：${context.file}`)
console.log(`模型（${modelNames.length}）：${modelNames.join(', ')}`)
console.log(
  `迁移版本：${context.migrations.map((migration) => `${migration.id}:${migration.name}`).join(', ') || '无'}`,
)

closeDatabase()
