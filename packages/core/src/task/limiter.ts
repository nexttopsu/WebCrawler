/**
 * 任务执行的并发与速率控制。
 *
 * 三层限制，对应任务书的要求：
 * - 全局并发：同时运行的任务数不超过上限，避免把所有站点一起打满；
 * - 单站点 / 单栏目并发：同一 key 内串行，防止对单个站点过度施压；
 * - 单栏目请求间隔：两次请求开始时间之间至少间隔 `minIntervalMs`。
 *
 * 所有等待都可被 `AbortSignal` 打断：任务取消后排队中的请求立即退出，
 * 不会在取消后继续发出请求。
 */

/** 取消时的统一错误；执行器据此区分「取消」与「真实失败」。 */
export class AbortedError extends Error {
  override readonly name = 'AbortedError'
  readonly code = 'ABORTED'

  constructor(message = '操作已取消') {
    super(message)
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError()
}

interface Waiter {
  key: string
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * 带 key 的并发闸门。
 *
 * 公平性按 FIFO 保证：先排队的先拿到名额，避免大任务饿死小任务。
 */
export class KeyedLimiter {
  private activeTotal = 0
  private readonly activeByKey = new Map<string, number>()
  private readonly waiters: Waiter[] = []

  constructor(
    private maxTotal: number,
    private maxPerKey: number,
  ) {
    if (maxTotal < 1) throw new Error('全局并发必须大于 0')
    if (maxPerKey < 1) throw new Error('单 key 并发必须大于 0')
  }

  /**
   * 调整上限。
   *
   * 只影响后续名额分配：已运行的任务不会被打断，调小后新任务排队等待，
   * 调大后立即唤醒排队中的等待者。
   */
  setLimits(maxTotal: number, maxPerKey = this.maxPerKey): void {
    if (maxTotal < 1) throw new Error('全局并发必须大于 0')
    if (maxPerKey < 1) throw new Error('单 key 并发必须大于 0')
    this.maxTotal = maxTotal
    this.maxPerKey = maxPerKey
    this.pump()
  }

  get limits(): { total: number; perKey: number } {
    return { total: this.maxTotal, perKey: this.maxPerKey }
  }

  get running(): number {
    return this.activeTotal
  }

  get queued(): number {
    return this.waiters.length
  }

  /** 取得一个名额；取消时抛出 `AbortedError`。 */
  acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError())

    if (this.canAcquire(key)) {
      this.take(key)
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { key, resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new AbortedError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  /** 释放名额并唤醒后续等待者。 */
  release(key: string): void {
    this.activeTotal = Math.max(0, this.activeTotal - 1)
    const current = (this.activeByKey.get(key) ?? 1) - 1
    if (current <= 0) this.activeByKey.delete(key)
    else this.activeByKey.set(key, current)
    this.pump()
  }

  /** 取得名额 → 执行 → 无论成败都释放。 */
  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(key, signal)
    try {
      return await fn()
    } finally {
      this.release(key)
    }
  }

  private canAcquire(key: string): boolean {
    if (this.activeTotal >= this.maxTotal) return false
    return (this.activeByKey.get(key) ?? 0) < this.maxPerKey
  }

  private take(key: string): void {
    this.activeTotal += 1
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1)
  }

  private pump(): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index]!
      if (waiter.signal?.aborted) {
        this.waiters.splice(index, 1)
        waiter.reject(new AbortedError())
        continue
      }
      if (!this.canAcquire(waiter.key)) {
        index += 1
        continue
      }
      this.waiters.splice(index, 1)
      this.take(waiter.key)
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
      // 名额已变化，从头重新扫描，保持 FIFO
      index = 0
    }
  }
}

/**
 * 按 key 限制请求频率：同一 key 两次「开始」之间至少间隔 `minIntervalMs`。
 *
 * 内部记录每个 key 的下次可执行时间，不依赖定时器轮询；
 * 等待期间收到取消信号会立即失败。
 */
export class IntervalLimiter {
  private readonly nextAllowedAt = new Map<string, number>()
  /** 同一 key 的并发为 1：间隔只有在串行时才真正可控 */
  private readonly gate: KeyedLimiter

  constructor(private readonly minIntervalMs: number) {
    if (minIntervalMs < 0) throw new Error('请求间隔不能为负数')
    this.gate = new KeyedLimiter(Number.MAX_SAFE_INTEGER, 1)
  }

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.gate.run(
      key,
      async () => {
        if (this.minIntervalMs > 0) {
          const now = Date.now()
          const next = this.nextAllowedAt.get(key) ?? 0
          const waitMs = next - now
          if (waitMs > 0) await delay(waitMs, signal)
          this.nextAllowedAt.set(key, Date.now() + this.minIntervalMs)
        }
        throwIfAborted(signal)
        return fn()
      },
      signal,
    )
  }
}

/** 可取消的延时。 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new AbortedError())

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
