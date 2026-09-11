import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { Turn } from '../../chat/turns'
import { captureAnchor, pruneMeasurements, TURN_ALIGN, type ScrollSnapshot } from '../../chat/scroll-state'
import { useMessageScroller } from '../ui/message-scroller'

/** The virtualizer measures history; only MessageScroller moves the viewport. */
export function useConversationScroll({
  historical,
  live,
  initialScrollState,
  onSave
}: {
  historical: Turn[]
  live: Turn[]
  initialScrollState?: ScrollSnapshot
  onSave: (state: ScrollSnapshot) => void
}) {
  const scroller = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const initial = useRef(initialScrollState).current
  const restored = useRef(false)
  const liveAnchor = live.findLast((turn) => turn.streaming)?.id
  const anchoredTurn = useRef(initial ? liveAnchor : undefined)
  const hadLive = useRef(live.length > 0)
  const [jump, setJump] = useState<{ index: number } | null>(null)
  const measurements = useMemo(() => pruneMeasurements(
    initial?.measurements ?? [],
    new Set(historical.map((turn) => turn.id!))
  ), [initial, historical])

  const virtualizer = useVirtualizer({
    count: historical.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => historical[index].id!,
    estimateSize: () => 160,
    overscan: 8,
    paddingStart: TURN_ALIGN,
    paddingEnd: live.length > 0 ? 0 : TURN_ALIGN,
    initialOffset: initial && !initial.following ? initial.scrollTop : undefined,
    initialMeasurementsCache: measurements,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    // Keep a requested offscreen row mounted until the next navigation. This
    // replaces polling for its DOM node and costs at most one additional row.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      return jump && jump.index < historical.length && !indexes.includes(jump.index)
        ? [...indexes, jump.index].sort((a, b) => a - b)
        : indexes
    },
    scrollToFn: (offset, { adjustments }) => {
      // Mount/default position and explicit jumps belong to MessageScroller.
      // Only pass through history's above-viewport size compensation.
      if (adjustments) scroller.scrollToOffset(offset + adjustments)
    }
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const { scrollTop, following } = scroller.getScrollState()
    if (following || scrollTop >= instance.getTotalSize() - TURN_ALIGN) return false
    if (!instance.itemSizeCache.has(item.key)) return item.start < scrollTop
    return item.end <= scrollTop && instance.scrollDirection !== 'backward'
  }

  useLayoutEffect(() => {
    if (restored.current) return
    restored.current = true
    if (!initial || initial.following) return
    if (initial.anchoredMessageId && live.some((turn) => turn.id === initial.anchoredMessageId)) {
      scroller.scrollToMessage(initial.anchoredMessageId, { anchor: true, scrollMargin: TURN_ALIGN })
      return
    }
    const anchor = initial.anchor
    if (anchor && live.some((turn) => turn.id === anchor.key)) {
      scroller.scrollToMessage(String(anchor.key), { scrollMargin: -anchor.offset })
      scroller.pauseAutoScroll()
      return
    }
    const row = anchor && virtualizer.measurementsCache.find((item) => item.key === anchor.key)
    // Prefer a stable row/offset when the history projection has changed.
    const offset = row && anchor ? row.start + anchor.offset : initial.scrollTop
    scroller.scrollToOffset(offset)
  }, [initial, scroller, virtualizer])

  useLayoutEffect(() => {
    if (!liveAnchor) {
      anchoredTurn.current = undefined
      return
    }
    if (anchoredTurn.current === liveAnchor) return
    anchoredTurn.current = liveAnchor
    scroller.scrollToMessage(liveAnchor, { anchor: true, scrollMargin: TURN_ALIGN })
  }, [liveAnchor, scroller])

  useLayoutEffect(() => {
    if (hadLive.current && live.length === 0) {
      const state = scroller.getScrollState()
      // Archiving replaces the live DOM with history. Release its old anchor
      // spacer without changing whether the reader chose to follow or pause.
      if (state.following) scroller.scrollToEnd()
      else scroller.scrollToOffset(state.scrollTop)
    }
    hadLive.current = live.length > 0
  }, [live.length, scroller])

  useLayoutEffect(() => {
    if (!jump) return
    const turn = historical[jump.index] ?? live[jump.index - historical.length]
    if (turn?.id) scroller.scrollToMessage(turn.id, { scrollMargin: TURN_ALIGN })
  }, [jump, scroller])

  const saveRef = useRef(() => {})
  saveRef.current = () => {
    const state = scroller.getScrollState()
    const rows = virtualizer.takeSnapshot()
    const viewport = viewportRef.current
    const bounds = viewport?.getBoundingClientRect()
    const liveRow = viewport && bounds && Array.from(viewport.querySelectorAll<HTMLElement>('[data-live-turn]'))
      .find((row) => {
        const rect = row.getBoundingClientRect()
        return rect.top <= bounds.top + TURN_ALIGN && rect.bottom > bounds.top + TURN_ALIGN
      })
    onSave({
      ...state,
      measurements: rows,
      anchor: captureAnchor(rows, state.scrollTop) ?? (liveRow && bounds ? {
        key: liveRow.dataset.messageId!,
        offset: bounds.top - liveRow.getBoundingClientRect().top
      } : null)
    })
  }
  useLayoutEffect(() => () => saveRef.current(), [])

  const jumpToTurn = useCallback((index: number) => {
    scroller.pauseAutoScroll()
    setJump({ index })
  }, [scroller])

  return { viewportRef, virtualizer, scroller, jumpToTurn }
}
