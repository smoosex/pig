import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { renderKeyForTurn, type Turn } from '../../chat/turns'
import { TURN_ALIGN, type ScrollSnapshot } from '../../chat/scroll-state'
import { useMessageScroller } from '../ui/message-scroller'

const INITIAL_TURNS = 20
const LOAD_MORE_TURNS = 20
/** History mounts one slide at a time instead of the whole suffix down to the newest turn. */
const WINDOW_TURNS = INITIAL_TURNS * 2
const EDGE_LOAD_THRESHOLD = 100
/** A restore pages in steps that each cover up to 200 turns; this stops a pathological window. */
const MAX_RESTORE_PAGES = 32

type VisibleTurn = {
  turn: Turn
  index: number
  key: string
}

type TurnAnchor = {
  key: string
  offset: number
  /** Position in the branch, when the row that carried it knew it. */
  index?: number
}

/** The window position of a saved anchor, by render key or entry id; -1 when it is not loaded. */
function indexOfAnchor(turns: Turn[], anchor: { key: string } | null): number {
  if (!anchor) return -1
  return turns.findIndex(
    (turn, index) => renderKeyForTurn(turn, index) === anchor.key || turn.id === anchor.key
  )
}

/** History paging and reading positions; MessageScroller owns every scroll write. */
export function useConversationScroll({
  active,
  historical,
  live,
  windowStart = 0,
  windowPending = false,
  hasMoreHistory = false,
  onLoadOlder,
  initialScrollState,
  onSave
}: {
  active: boolean
  historical: Turn[]
  live: Turn[]
  /** Index of `historical[0]` in the branch, so a prepended page can keep the reading position. */
  windowStart?: number
  /** The window's offset is still provisional, so a row's branch index cannot be trusted yet. */
  windowPending?: boolean
  hasMoreHistory?: boolean
  onLoadOlder?: (target?: number) => void
  initialScrollState?: ScrollSnapshot
  onSave: (state: ScrollSnapshot) => void
}) {
  const scroller = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const turnRefs = useRef(new Map<string, HTMLDivElement>())
  const latest = useRef<ScrollSnapshot | undefined>(initialScrollState)
  const pendingRestore = useRef<ScrollSnapshot | null>(null)
  const previousLiveCount = useRef(live.length)
  const windowChanging = useRef(false)
  const lastScrollTop = useRef<number | null>(null)
  const pendingWindow = useRef<TurnAnchor | null>(null)
  const restorePages = useRef(0)
  const stableAnchor = useRef<TurnAnchor | null>(null)
  const [historyStart, setHistoryStart] = useState(() => Math.max(0, historical.length - INITIAL_TURNS))
  const [jumpRequest, setJumpRequest] = useState<{ index: number; token: number } | null>(null)
  const jumpToken = useRef(0)
  const loadedStart = useRef(windowStart)

  const allTurns = useMemo(() => [...historical, ...live], [historical, live])
  const visibleStart = Math.min(historyStart, Math.max(0, historical.length - INITIAL_TURNS))
  const visibleEnd = Math.min(historical.length, visibleStart + WINDOW_TURNS)
  const visibleTurns = useMemo<VisibleTurn[]>(() => [
    ...historical.slice(visibleStart, visibleEnd).map((turn, offset) => ({
      turn,
      index: visibleStart + offset,
      key: renderKeyForTurn(turn, visibleStart + offset)
    })),
    ...live.map((turn, offset) => ({
      turn,
      index: historical.length + offset,
      key: renderKeyForTurn(turn, historical.length + offset)
    }))
  ], [historical, live, visibleEnd, visibleStart])

  // Measured from the rendered rows, not from the turn list: a page can arrive while the list is
  // already longer than what is on screen, and the reading row is whichever one is painted.
  const measureRow = useCallback((): { element: HTMLElement; key: string; offset: number; index?: number } | null => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return null
    const viewportRect = viewport.getBoundingClientRect()
    const bound = viewportRect.top + TURN_ALIGN
    for (const element of content.querySelectorAll<HTMLElement>('[data-turn-key]')) {
      if (!element.isConnected) continue
      const rect = element.getBoundingClientRect()
      if (rect.bottom <= bound) continue
      const key = element.dataset.turnKey
      const turnIndex = Number(element.dataset.turnIndex)
      if (key) {
        return {
          element,
          key,
          offset: rect.top - viewportRect.top,
          ...(Number.isFinite(turnIndex) ? { index: turnIndex } : {})
        }
      }
    }
    return null
  }, [])

  const measureAnchor = useCallback((): TurnAnchor | null => {
    const row = measureRow()
    return row ? { key: row.key, offset: row.offset, ...(row.index === undefined ? {} : { index: row.index }) } : null
  }, [measureRow])

  const reanchor = useCallback(() => {
    const anchor = stableAnchor.current
    const viewport = viewportRef.current
    if (!anchor || !viewport) return
    const element = turnRefs.current.get(anchor.key)
    if (!element) return
    const offset = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    if (Math.abs(offset - anchor.offset) < 0.5) return
    viewport.scrollTop += offset - anchor.offset
  }, [])

  // Hiding a pane destroys its scroll offset, so the reading position is captured while visible.
  const capture = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || viewport.clientHeight === 0) return
    const anchor = measureAnchor()
    stableAnchor.current = anchor
    latest.current = {
      scrollTop: viewport.scrollTop,
      following: scroller.getScrollState().following,
      // A provisional window labels its rows with positions it cannot back yet, so a snapshot taken
      // then keeps only the row identity: the offset is recovered when the window settles.
      anchor: anchor && !windowPending ? anchor : anchor && { key: anchor.key, offset: anchor.offset }
    }
  }, [measureAnchor, scroller, windowPending])

  // Rows enter and leave offscreen, so the reading row is re-anchored after the commit.
  const changeWindow = useCallback((next: number) => {
    if (windowChanging.current) return
    windowChanging.current = true
    pendingWindow.current = measureAnchor()
    setHistoryStart(next)
  }, [measureAnchor])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    capture()
    const viewport = event.currentTarget
    const previousScrollTop = lastScrollTop.current
    lastScrollTop.current = viewport.scrollTop
    if (windowChanging.current) return
    if (scroller.getScrollState().following) {
      // A follower always tracks the newest turns, even after the window was trimmed.
      setHistoryStart(Math.max(0, historical.length - INITIAL_TURNS))
      return
    }
    if (viewport.scrollTop <= EDGE_LOAD_THRESHOLD) {
      const next = Math.max(0, visibleStart - LOAD_MORE_TURNS)
      if (next !== visibleStart) changeWindow(next)
      // Only a reader moving up asks for older turns; sitting near the top must not chain-load.
      else if (hasMoreHistory && (previousScrollTop == null || viewport.scrollTop < previousScrollTop)) {
        onLoadOlder?.()
      }
      return
    }
    if (
      visibleEnd < historical.length &&
      viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - EDGE_LOAD_THRESHOLD
    ) {
      changeWindow(visibleStart + LOAD_MORE_TURNS)
    }
  }, [capture, changeWindow, hasMoreHistory, historical.length, onLoadOlder, scroller, visibleEnd, visibleStart])

  // Older turns are prepended: the mounted slide has to shift with them, and the reading position
  // has to survive the resize, which the compensation below takes care of.
  useLayoutEffect(() => {
    const prepended = loadedStart.current - windowStart
    loadedStart.current = windowStart
    if (prepended > 0) setHistoryStart((start) => start + prepended)
  }, [windowStart])

  useLayoutEffect(() => {
    if (!windowChanging.current) return
    windowChanging.current = false
    const pending = pendingWindow.current
    pendingWindow.current = null
    if (!pending) return
    stableAnchor.current = pending
    reanchor()
  }, [reanchor, visibleEnd, visibleStart])

  useLayoutEffect(() => {
    if (!active || live.length <= previousLiveCount.current) {
      previousLiveCount.current = live.length
      return
    }
    // A new live turn means the user sent a prompt: mount the tail and fall back in line with the answer.
    previousLiveCount.current = live.length
    setHistoryStart(Math.max(0, historical.length - INITIAL_TURNS))
    scroller.scrollToEnd()
  }, [active, historical.length, live.length, scroller])

  useLayoutEffect(() => {
    // Effects run only while the pane is visible, so this is also the reactivation hook.
    pendingRestore.current = latest.current ?? { scrollTop: 0, following: true, anchor: null }
    restorePages.current = 0
    return () => { pendingRestore.current = null }
  }, [])

  useLayoutEffect(() => {
    // Above-viewport size changes (image decode, folding) keep the paused reader in place.
    const content = contentRef.current
    if (!active || !content) return
    const observer = new ResizeObserver(() => {
      if (windowChanging.current || scroller.getScrollState().following) return
      reanchor()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [active, reanchor, scroller])

  useLayoutEffect(() => {
    if (!active || allTurns.length === 0) return
    const pending = pendingRestore.current
    const viewport = viewportRef.current
    if (!pending || !viewport) return
    if (pending.following) {
      pendingRestore.current = null
      setHistoryStart(Math.max(0, historical.length - INITIAL_TURNS))
      scroller.scrollToEnd()
      return
    }
    const anchor = pending.anchor
    const targetIndex = indexOfAnchor(allTurns, anchor)
    if (
      anchor &&
      targetIndex < 0 &&
      anchor.index !== undefined &&
      anchor.index < windowStart &&
      onLoadOlder &&
      restorePages.current < MAX_RESTORE_PAGES
    ) {
      restorePages.current += 1
      // The branch came back with its tail only, and the saved turn is above it: page the window that
      // holds the reading position before aligning, and keep the request pending until it lands.
      onLoadOlder(anchor.index)
      return
    }
    if (
      targetIndex >= 0 &&
      targetIndex < historical.length &&
      (targetIndex < visibleStart || targetIndex >= visibleEnd)
    ) {
      // Retry once the paged-in rows are mounted; the request stays pending on purpose.
      changeWindow(Math.max(0, targetIndex - LOAD_MORE_TURNS))
      return
    }
    pendingRestore.current = null
    const element = targetIndex < 0 ? undefined : turnRefs.current.get(renderKeyForTurn(allTurns[targetIndex], targetIndex))
    if (!element || !anchor) {
      scroller.scrollToOffset(pending.scrollTop)
      return
    }
    const offset = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    scroller.scrollToOffset(viewport.scrollTop + offset - anchor.offset)
  }, [active, allTurns, changeWindow, historical.length, onLoadOlder, scroller, visibleEnd, visibleStart, windowStart])

  useLayoutEffect(() => {
    // A paused reader keeps the mounted window; only a follower tracks the end of history.
    if (!active || !scroller.getScrollState().following) return
    setHistoryStart(Math.max(0, historical.length - INITIAL_TURNS))
  }, [active, historical.length, scroller])

  useLayoutEffect(() => {
    if (!jumpRequest) return
    const target = allTurns[jumpRequest.index]
    if (!target) {
      setJumpRequest(null)
      return
    }
    if (
      jumpRequest.index < historical.length &&
      (jumpRequest.index < visibleStart || jumpRequest.index >= visibleEnd)
    ) {
      changeWindow(Math.max(0, jumpRequest.index - LOAD_MORE_TURNS))
      return
    }
    if (scroller.scrollToMessage(renderKeyForTurn(target, jumpRequest.index), { scrollMargin: TURN_ALIGN })) {
      setJumpRequest(null)
    }
  }, [allTurns, changeWindow, historical.length, jumpRequest, scroller, visibleEnd, visibleStart])

  /** Mounts the slide of already loaded turns above the window, keeping the reading row in place. */
  const loadEarlier = useCallback(() => {
    const next = Math.max(0, visibleStart - LOAD_MORE_TURNS)
    if (next !== visibleStart) changeWindow(next)
  }, [changeWindow, visibleStart])

  const registerTurn = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) turnRefs.current.set(key, element)
    else turnRefs.current.delete(key)
  }, [])
  const jumpToTurn = useCallback((index: number) => {
    if (index < 0 || index >= allTurns.length) return
    jumpToken.current += 1
    setJumpRequest({ index, token: jumpToken.current })
  }, [allTurns.length])

  const saveRef = useRef(onSave)
  saveRef.current = onSave
  useLayoutEffect(() => () => {
    saveRef.current(latest.current ?? { scrollTop: 0, following: true, anchor: null })
  }, [])

  return {
    viewportRef,
    contentRef,
    visibleTurns,
    loadEarlier,
    hasMoreAbove: visibleStart > 0,
    hasMoreBelow: visibleEnd < historical.length,
    onScroll,
    registerTurn,
    jumpToTurn
  }
}
