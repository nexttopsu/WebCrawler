/** 透出 ORMlet 的连接类型，业务层无需直接依赖 ormlet。 */
export type { Database, ModelData, ModelRow } from 'ormlet'

export * from './connection.js'
export * from './debug.js'
export * from './migrations/index.js'
export * from './models/fields.js'
export * from './models/index.js'

export const DATABASE_PACKAGE = {
  name: 'database',
  version: '0.7.0',
  description: '数据库层（ORMlet + SQLite）',
} as const
