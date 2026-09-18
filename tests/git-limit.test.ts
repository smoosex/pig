/**
 * The limiter is what keeps a burst of card reads from turning into a burst of MiB-sized buffers, and what
 * keeps a refresh's thousands of stats from queueing in one go. It is pure, so it is checked here rather
 * than through the app; `diff.ts` builds the two pools it uses from this.
 */
import { describe, expect, test } from 'bun:test'
import { countLanes, createLimiter, readLanes } from '../src/main/git/limit'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createLimiter', () => {
  test('never runs more than its lanes at once', async () => {
    const limiter = createLimiter(3)
    let live = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.run(async () => {
          live++
          peak = Math.max(peak, live)
          await sleep(5)
          live--
        })
      )
    )

    expect(peak).toBe(3)
  })

  test('hands lanes out in the order they were asked for', async () => {
    const limiter = createLimiter(1)
    const order: number[] = []

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        limiter.run(async () => {
          order.push(index)
          await sleep(1)
        })
      )
    )

    expect(order).toEqual([0, 1, 2, 3, 4, 5])
  })

  test('a task that throws gives its lane back, and only its own caller hears about it', async () => {
    const limiter = createLimiter(2)
    await expect(
      limiter.run(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(await Promise.all([1, 2, 3, 4].map((n) => limiter.run(async () => n * 2)))).toEqual([2, 4, 6, 8])
  })

  test('refuses to be built with no lane, which would queue forever', () => {
    expect(() => createLimiter(0)).toThrow()
  })
})

describe('the pools the git layer uses', () => {
  test('a backlog of count validation cannot stand in front of a content read', async () => {
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const backlog = Array.from({ length: 24 }, () => countLanes.run(() => gate))

    let guard: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'waited'>((resolve) => {
      guard = setTimeout(() => resolve('waited'), 2000)
    })

    try {
      // Three rounds of the validation pool are held open by a gate only this test opens. One shared queue
      // would make the read below wait for that gate; two pools let it take a lane of its own right away.
      const outcome = await Promise.race([readLanes.run(async () => 'read' as const), deadline])
      expect(outcome).toBe('read')
    } finally {
      clearTimeout(guard)
      open()
      await Promise.all(backlog)
    }
  })
})
