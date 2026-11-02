import { describe, expect, it } from 'vitest'
import {
  AbortedError,
  IntervalLimiter,
  KeyedLimiter,
} from '../src/task/limiter.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('KeyedLimiter', () => {
  it('全局并发不超过上限', async () => {
    const limiter = new KeyedLimiter(2, 2)
    let running = 0
    let peak = 0

    const job = async (): Promise<void> => {
      running += 1
      peak = Math.max(peak, running)
      await sleep(20)
      running -= 1
    }

    await Promise.all(Array.from({ length: 6 }, () => limiter.run(`k${Math.random()}`, job)))
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1)
  })

  it('同一 key 内串行，不同 key 可并行', async () => {
    const limiter = new KeyedLimiter(4, 1)
    let activeA = 0
    let peakA = 0
    let activeB = 0
    let peakB = 0

    const jobA = async (): Promise<void> => {
      activeA += 1
      peakA = Math.max(peakA, activeA)
      await sleep(15)
      activeA -= 1
    }
    const jobB = async (): Promise<void> => {
      activeB += 1
      peakB = Math.max(peakB, activeB)
      await sleep(15)
      activeB -= 1
    }

    await Promise.all([
      limiter.run('A', jobA),
      limiter.run('A', jobA),
      limiter.run('A', jobA),
      limiter.run('B', jobB),
      limiter.run('B', jobB),
    ])

    expect(peakA).toBe(1)
    expect(peakB).toBe(1)
  })

  it('排队中的请求可被取消', async () => {
    const limiter = new KeyedLimiter(1, 1)
    const controller = new AbortController()
    const first = limiter.run('A', () => sleep(30))
    const queued = limiter.run('A', () => sleep(5), controller.signal)

    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(AbortedError)
    await first
    expect(limiter.queued).toBe(0)
    expect(limiter.running).toBe(0)
  })
})

describe('IntervalLimiter', () => {
  it('同一 key 两次开始之间至少间隔 minIntervalMs', async () => {
    const limiter = new IntervalLimiter(25)
    const starts: number[] = []
    await Promise.all([
      limiter.run('k', async () => {
        starts.push(Date.now())
      }),
      limiter.run('k', async () => {
        starts.push(Date.now())
      }),
      limiter.run('k', async () => {
        starts.push(Date.now())
      }),
    ])

    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(20)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(20)
  })

  it('间隔为 0 时不额外等待', async () => {
    const limiter = new IntervalLimiter(0)
    const started = Date.now()
    await limiter.run('k', async () => undefined)
    expect(Date.now() - started).toBeLessThan(20)
  })
})
