import { getModels } from '../../database/index.js'
import type { ProxyUsageDelta } from '../../shared/index.js'

/**
 * 代理使用统计的批量缓冲。
 *
 * 任务可能每分钟发出上千次请求，逐请求写库既慢又会加剧 SQLite 写锁竞争。
 * 这里先在内存累加，由定时器（或任务结束时）批量刷盘。
 * 进程退出前调用 `flushProxyStats()`，避免丢失最后一次统计。
 */
const buffer = new Map<number, ProxyUsageDelta>()

/** 记录一次经代理发出的请求。 */
export function recordProxyUsage(proxyId: number, ok: boolean): void {
  const now = new Date().toISOString()
  const current = buffer.get(proxyId) ?? {
    requestCount: 0,
    successCount: 0,
    failedCount: 0,
    lastUsedAt: now,
  }
  current.requestCount += 1
  if (ok) current.successCount += 1
  else current.failedCount += 1
  current.lastUsedAt = now
  buffer.set(proxyId, current)
}

/** 当前缓冲的代理数量，测试可用于断言「没有逐请求写库」。 */
export function pendingProxyStats(): number {
  return buffer.size
}

/** 把缓冲写回数据库；单条失败不影响其余记录。 */
export function flushProxyStats(): number {
  if (buffer.size === 0) return 0
  const models = getModels()
  let flushed = 0

  for (const [proxyId, delta] of buffer) {
    try {
      const row = models.proxy.findById(proxyId)
      if (!row) continue
      models.proxy.update(proxyId, {
        requestCount: (row.requestCount ?? 0) + delta.requestCount,
        successCount: (row.successCount ?? 0) + delta.successCount,
        failCount: (row.failCount ?? 0) + delta.failedCount,
        lastUsedAt: delta.lastUsedAt,
      })
      flushed += 1
    } catch {
      // 数据库暂不可用时保留缓存，下一次 flush 再试
      continue
    }
    buffer.delete(proxyId)
  }

  return flushed
}

/** 启动定时刷盘，返回停止函数。 */
export function startProxyStatsFlusher(intervalMs = 5000): () => void {
  const timer = setInterval(() => flushProxyStats(), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
