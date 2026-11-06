/**
 * How much of the git layer's file work may be in flight at once. Reading an untracked file holds a
 * ~1 MiB buffer for as long as the read takes, so only a few may run however many cards ask. Background
 * counts use 64 KiB buffers. Foreground reads, metadata validation, and background counts have separate
 * pools: neither listing nor opening a card may queue behind cold background reads.
 */
export interface Limiter {
  /** Runs `task` once a lane is free. The lane comes back whatever the task does. */
  run: <T>(task: () => Promise<T>) => Promise<T>
}

/** Bounds how many tasks run at once; the rest wait their turn in the order they were asked for. */
export function createLimiter(lanes: number): Limiter {
  if (lanes < 1) throw new Error('a limiter needs at least one lane')
  const waiting: (() => void)[] = []
  let live = 0

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (live < lanes) live++
      else await new Promise<void>((resolve) => waiting.push(resolve))
      try {
        return await task()
      } finally {
        const next = waiting.shift()
        // A waiter inherits the lane as it is: it was never given back, so `live` stays where it was.
        if (next) next()
        else live--
      }
    }
  }
}

/** Untracked contents: four buffers of about a MiB are the whole memory budget of a burst. File tabs read
 * through the same pool — their buffer is a couple of MiB, and a change event asks for every open one at
 * once — so the pool bounds what content is in memory at a time, not what asked for it. */
export const readLanes = createLimiter(4)
/** Metadata-only validation for list refreshes, independent of cold content reads. */
export const countLanes = createLimiter(4)
/** Background line counting never queues in front of list validation or foreground reads. */
export const backgroundCountLanes = createLimiter(4)
