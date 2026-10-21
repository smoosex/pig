/**
 * Entry and exit motion for the tab strip. The strip is centred and sized by its tabs, so a tab that
 * appears at full width or vanishes at once jolts the whole strip sideways while the selection's own
 * flex-basis transition catches up. A new tab grows from nothing and a closed one stays behind as an
 * inert copy that collapses to nothing, so the strip's width changes continuously.
 *
 * Only additions and removals within one strip animate: switching worktree or sidebar half replaces
 * the strip outright, and members of a split collapse into one merged tab without motion.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export const TAB_MOTION_MS = 200
const EASING = 'ease-in-out'

export interface LeavingTab<T> {
  key: string
  /** The key of the tab it followed, or null when it led the strip. */
  after: string | null
  width: number
  snapshot: T
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Only called for copies the hook created, which it never does under reduced motion. */
export function collapseLeavingTab(element: HTMLElement, width: number, onDone: () => void): void {
  element.animate(
    [
      { flexBasis: `${width}px`, paddingInline: '6px', opacity: 1 },
      { flexBasis: '0px', paddingInline: '0px', opacity: 0 }
    ],
    { duration: TAB_MOTION_MS, easing: EASING, fill: 'forwards' }
  ).onfinish = onDone
}

export function useTabStripMotion<T>({
  listRef,
  context,
  entries,
  still,
  onEntered
}: {
  listRef: RefObject<HTMLElement | null>
  context: string
  entries: { key: string; snapshot: T }[]
  /** Keys that never animate in or out. */
  still: ReadonlySet<string>
  onEntered: () => void
}) {
  const [leaving, setLeaving] = useState<LeavingTab<T>[]>([])
  const previous = useRef<{ context: string; entries: { key: string; snapshot: T }[]; still: ReadonlySet<string> } | null>(null)
  const widths = useRef(new Map<string, number>())
  const observer = useRef<ResizeObserver | null>(null)
  const signature = entries.map((entry) => entry.key).join('\n')

  // Re-observed only when the set of tabs changes; each observation reports its first size by itself.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    observer.current ??= new ResizeObserver((records) => {
      for (const record of records) {
        widths.current.set((record.target as HTMLElement).dataset.tabKey!, record.borderBoxSize[0].inlineSize)
      }
    })
    observer.current.disconnect()
    for (const element of list.querySelectorAll<HTMLElement>('[data-tab-key]')) observer.current.observe(element)
  }, [context, signature])
  useLayoutEffect(() => () => observer.current?.disconnect(), [])

  useLayoutEffect(() => {
    const prior = previous.current
    previous.current = { context, entries, still }
    if (!prior) return
    if (prior.context !== context) {
      widths.current.clear()
      setLeaving((current) => (current.length ? [] : current))
      return
    }
    const keys = new Set(entries.map((entry) => entry.key))
    const priorKeys = new Set(prior.entries.map((entry) => entry.key))
    const animates = (key: string) => !still.has(key) && !prior.still.has(key)
    const motion = !reducedMotion()
    for (const { key } of entries) {
      if (priorKeys.has(key) || !animates(key) || !motion) continue
      const element = listRef.current?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`)
      if (!element) continue
      // A lone keyframe defaults to offset 1, the end; pinned to 0 it animates from nothing to whatever
      // the tab's classes resolve to.
      element.animate(
        [{ offset: 0, flexBasis: '0px', flexGrow: 0, minWidth: '0px', paddingInline: '0px', opacity: 0 }],
        { duration: TAB_MOTION_MS, easing: EASING }
      ).onfinish = onEntered
    }
    const gone: LeavingTab<T>[] = []
    prior.entries.forEach((entry, index) => {
      if (keys.has(entry.key)) return
      const width = widths.current.get(entry.key) ?? 0
      widths.current.delete(entry.key)
      if (!animates(entry.key) || !motion) return
      gone.push({
        key: entry.key,
        after: index > 0 ? prior.entries[index - 1].key : null,
        width,
        snapshot: entry.snapshot
      })
    })
    setLeaving((current) => {
      const kept = current.filter((item) => !keys.has(item.key))
      return gone.length || kept.length !== current.length ? [...kept, ...gone] : current
    })
    // `entries` and `still` are rebuilt every render; the signature says when the strip actually changed.
  }, [context, signature])

  const finishLeaving = (key: string) => setLeaving((current) => current.filter((item) => item.key !== key))
  return { leaving, finishLeaving }
}

/** Places each leaving copy after the tab it followed; copies whose neighbour is also gone go last. */
export function interleave<T, L extends { key: string; after: string | null }>(
  items: T[],
  keyOf: (item: T) => string,
  leaving: L[]
): ({ item: T } | { leaving: L })[] {
  const placed = new Set<string>()
  const out: ({ item: T } | { leaving: L })[] = []
  const emitAfter = (key: string | null) => {
    for (const ghost of leaving) {
      if (ghost.after !== key || placed.has(ghost.key)) continue
      placed.add(ghost.key)
      out.push({ leaving: ghost })
      emitAfter(ghost.key)
    }
  }
  emitAfter(null)
  for (const item of items) {
    out.push({ item })
    emitAfter(keyOf(item))
  }
  for (const ghost of leaving) if (!placed.has(ghost.key)) out.push({ leaving: ghost })
  return out
}
