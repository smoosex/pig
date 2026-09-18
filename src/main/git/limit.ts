/**
 * How much of the git layer's file work may be in flight at once. Reading an untracked file holds a
 * ~1 MiB buffer for as long as the read takes, so only a few may run however many cards ask; validating
 * the counts a refresh already knows only stats, but one refresh can queue thousands of those.
 *
 * Two pools rather than one shared queue: a refresh's backlog must never stand in front of a card's read.
 * A linter cannot see the difference — both are limiter objects — so `tests/git-limit.test.ts` checks it
 * by queueing slow work in one and reading from the other.
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

/** Untracked contents: four buffers of about a MiB are the whole memory budget of a burst. */
export const readLanes = createLimiter(4)
/** Count validation: stats only, but a refresh can hand this pool thousands of them. */
export const countLanes = createLimiter(8)
