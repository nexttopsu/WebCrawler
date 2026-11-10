/**
 * 调试库初始化（`data/debug.db`）。
 *
 * 关注两件事：
 * 1. **缺失即创建**：文件 / 父目录不存在时，初始化要一路建好表与索引，不能要求先手工建库；
 * 2. **自愈**：连接关闭后再访问（`ensureDebugDatabase`）按上次路径重建，不会静默失效。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEBUG_SAMPLE_TABLE,
  closeDebugDatabase,
  ensureDebugDatabase,
  initDebugDatabase,
  isDebugDatabaseInitialized,
  lastDebugDatabaseFile,
} from '../../src/database/index.js'

const tempDirs: string[] = []

function tempFile(name = 'debug.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'webcrawler-debug-db-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  closeDebugDatabase()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('调试库初始化', () => {
  it('文件与父目录都不存在时自动创建库、表与索引', () => {
    const file = tempFile()
    const context = initDebugDatabase(file)

    expect(existsSync(file)).toBe(true)
    expect(context.file).toBe(file)

    const tables = context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toContain(DEBUG_SAMPLE_TABLE)

    // 建表可用：写入后能读回
    context.db
      .prepare(
        `INSERT INTO ${DEBUG_SAMPLE_TABLE} (url, raw, statusCode, contentType, enabled, hitCount, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run('https://debug.local/a', '<html></html>', 200, 'html', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const row = context.db
      .prepare(`SELECT url FROM ${DEBUG_SAMPLE_TABLE} WHERE url = ?`)
      .get('https://debug.local/a') as unknown as { url: string } | undefined
    expect(row?.url).toBe('https://debug.local/a')
  })

  it('同一文件重复初始化复用同一连接', () => {
    const file = tempFile()
    const first = initDebugDatabase(file)
    const second = initDebugDatabase(file)
    expect(second.db).toBe(first.db)
  })

  it('ensureDebugDatabase 未初始化时建库、已初始化时直接复用', () => {
    const file = tempFile()
    expect(isDebugDatabaseInitialized()).toBe(false)

    const created = ensureDebugDatabase(file)
    expect(existsSync(file)).toBe(true)

    const reused = ensureDebugDatabase(file)
    expect(reused.db).toBe(created.db)
  })

  it('关闭后按上次使用的路径重建（不依赖调用方再传配置）', () => {
    const file = tempFile()
    initDebugDatabase(file)
    expect(lastDebugDatabaseFile()).toBe(file)

    closeDebugDatabase()
    expect(isDebugDatabaseInitialized()).toBe(false)

    const rebuilt = ensureDebugDatabase(lastDebugDatabaseFile() ?? '')
    expect(rebuilt.file).toBe(file)
    expect(existsSync(file)).toBe(true)
  })

  it('内存库每次初始化都新建，测试之间不互相污染', () => {
    const first = initDebugDatabase(':memory:')
    first.db
      .prepare(
        `INSERT INTO ${DEBUG_SAMPLE_TABLE} (url, raw, statusCode, contentType, enabled, hitCount, createdAt, updatedAt)
         VALUES ('https://debug.local/x', '', 200, 'html', 1, 0, '', '')`,
      )
      .run()

    const second = initDebugDatabase(':memory:')
    const row = second.db.prepare(`SELECT COUNT(*) AS total FROM ${DEBUG_SAMPLE_TABLE}`).get() as unknown as {
      total: number
    }
    expect(row.total).toBe(0)
  })
})
