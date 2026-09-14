import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { renderKeyForTurn, type Turn } from '../../chat/turns'
import { TURN_ALIGN, type ScrollSnapshot } from '../../chat/scroll-state'
import { useMessageScroller } from '../ui/message-scroller'

const INITIAL_TURNS = 20
const LOAD_MORE_TURNS = 20
const TOP_LOAD_THRESHOLD = 100

type VisibleTurn = {
  turn: Turn
  index: number
  key: string
}

/** History paging and reading positions; MessageScroller owns every scroll write. */
export function useConversationScroll({
  active,
  historical,
  live,
  initialScrollState,
  onSave
}: {
  active: boolean
  historical: Turn[]
  live: Turn[]
  initialScrollState?: ScrollSnapshot
  onSave: (state: ScrollSnapshot) => void
}) {
  const scroller = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const turnRefs = useRef(new Map<string, HTMLDivElement>())
  const latest = useRef<ScrollSnapshot | undefined>(initialScrollState)
  const pendingRestore = useRef<ScrollSnapshot | null>(null)
  const previousLiveCount = useRef(live.length)
  const pendingPrepend = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const loadingAbove = useRef(false)
  const [historyStart, setHistoryStart] = useState(() => Math.max(0, historical.length - INITIAL_TURNS))
  const [jumpRequest, setJumpRequest] = useState<{ index: number; token: number } | null>(null)
  const jumpToken = useRef(0)

  const allTurns = useMemo(() => [...historical, ...live], [historical, live])
  const visibleStart = Math.min(historyStart, Math.max(0, historical.length - INITIAL_TURNS))
  const visibleTurns = useMemo<VisibleTurn[]>(() => [
    ...historical.slice(visibleStart).map((turn, offset) => ({
      turn,
      index: visibleStart + offset,
      key: renderKeyForTurn(turn, visibleStart + offset)
    })),
    ...live.map((turn, offset) => ({
      turn,
      index: historical.length + offset,
      key: renderKeyForTurn(turn, historical.length + offset)
    }))
  ], [historical, live, visibleStart])

  // Hiding a pane destroys its scroll offset, so the reading position is captured while visible.
  const capture = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || viewport.clientHeight === 0) return
    const viewportRect = viewport.getBoundingClientRect()
    const anchor = visibleTurns.find(({ key }) => {
      const element = turnRefs.current.get(key)
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return rect.top <= viewportRect.top + TURN_ALIGN && rect.bottom > viewportRect.top + TURN_ALIGN
    })
    const anchorRect = anchor ? turnRefs.current.get(anchor.key)?.getBoundingClientRect() : undefined
    latest.current = {
      scrollTop: viewport.scrollTop,
      following: scroller.getScrollState().following,
      anchor: anchor && anchorRect ? { key: anchor.key, offset: anchorRect.top - viewportRect.top } : null
    }
  }, [scroller, visibleTurns])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    capture()
    const viewport = event.currentTarget
    const next = Math.max(0, visibleStart - LOAD_MORE_TURNS)
    if (loadingAbove.current || next === visibleStart || viewport.scrollTop > TOP_LOAD_THRESHOLD) return
    // Rows are inserted above the reading position, so remember the pre-insert sizes.
    loadingAbove.current = true
    pendingPrepend.current = { scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop }
    setHistoryStart(next)
  }, [capture, visibleStart])

  useLayoutEffect(() => {
    loadingAbove.current = false
    const pending = pendingPrepend.current
    const viewport = viewportRef.current
    if (!pending || !viewport) return
    viewport.scrollTop = pending.scrollTop + (viewport.scrollHeight - pending.scrollHeight)
    pendingPrepend.current = null
  }, [visibleStart])

  useLayoutEffect(() => {
    if (!active || live.length <= previousLiveCount.current) {
      previousLiveCount.current = live.length
      return
    }
    // A new live turn means the user sent a prompt: fall back in line with the answer.
    previousLiveCount.current = live.length
    scroller.scrollToEnd()
  }, [active, live.length, scroller])

  useLayoutEffect(() => {
    // Effects run only while the pane is visible, so this is also the reactivation hook.
    pendingRestore.current = latest.current ?? { scrollTop: 0, following: true, anchor: null }
    return () => { pendingRestore.current = null }
  }, [])

  useLayoutEffect(() => {
    if (!active || allTurns.length === 0) return
    const pending = pendingRestore.current
    const viewport = viewportRef.current
    if (!pending || !viewport) return
    if (pending.following) {
      pendingRestore.current = null
      scroller.scrollToEnd()
      return
    }
    const anchor = pending.anchor
    const targetIndex = anchor
      ? allTurns.findIndex((turn, index) => renderKeyForTurn(turn, index) === anchor.key || turn.id === anchor.key)
      : -1
    if (targetIndex >= 0 && targetIndex < visibleStart) {
      // Retry once the paged-in rows are mounted; the request stays pending on purpose.
      setHistoryStart(Math.max(0, targetIndex - LOAD_MORE_TURNS))
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
  }, [active, allTurns, scroller, visibleStart])

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
    if (jumpRequest.index < visibleStart) {
      setHistoryStart(Math.max(0, jumpRequest.index - LOAD_MORE_TURNS))
      return
    }
    if (scroller.scrollToMessage(renderKeyForTurn(target, jumpRequest.index), { scrollMargin: TURN_ALIGN })) {
      setJumpRequest(null)
    }
  }, [allTurns, jumpRequest, scroller, visibleStart])

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
    visibleTurns,
    hasMoreAbove: visibleStart > 0,
    onScroll,
    registerTurn,
    jumpToTurn
  }
}
