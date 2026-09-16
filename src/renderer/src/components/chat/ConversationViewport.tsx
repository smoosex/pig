import { useCallback, useMemo, useRef } from 'react'
import { chatColumn } from '../../chat/layout'
import { summaryMinimapItem, turnMinimapItem, type MinimapItem } from '../../chat/minimap'
import type { ScrollSnapshot } from '../../chat/scroll-state'
import type { TurnSummary } from '../../ipc/api'
import type { Turn } from '../../chat/turns'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { useSessionsStore } from '../../stores/sessions'
import { TurnView } from '../TurnView'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScroller
} from '../ui/message-scroller'
import { TurnMinimap } from './TurnMinimap'
import { useConversationScroll } from './useConversationScroll'

const measuredItem = '[content-visibility:visible] [contain-intrinsic-size:none]'
/** A jump pages at most this far; a click further back grows the window and can be repeated. */
const MAX_JUMP_PAGES = 32

export function ConversationViewport({
  active,
  historical,
  live,
  sessionId,
  windowStart,
  indexTrusted,
  loadingOlder,
  loadError,
  summary,
  initialScrollState,
  onSave
}: {
  active: boolean
  historical: Turn[]
  live: Turn[]
  sessionId: string
  /** Index of `historical[0]` in the branch: everything below it is still on disk. */
  windowStart: number
  /** Opening shows the tail before the branch index exists, so `windowStart` is not real yet. */
  indexTrusted: boolean
  /** A page of older turns is on its way. */
  loadingOlder?: boolean
  /** Older turns could not be loaded, so the hint must not promise them again. */
  loadError?: string | null
  summary: TurnSummary[]
  initialScrollState?: ScrollSnapshot
  onSave: (state: ScrollSnapshot) => void
}) {
  // The minimap only needs a stable identity per turn set; live text growth must not rebuild every row.
  // Loaded turns keep the branch's weight when the summary knows them, so one branch has one scale.
  const items = useMemo<MinimapItem[]>(() => [
    ...summary.slice(0, windowStart).map(summaryMinimapItem),
    ...historical.map((turn, offset) => {
      const index = windowStart + offset
      const row = summary[index]
      return turnMinimapItem(turn, index, row?.id === turn.id ? row.bytes : undefined)
    }),
    ...live.map((turn, offset) => turnMinimapItem(turn, windowStart + historical.length + offset))
  ], [historical, live.length, summary, windowStart])
  const scroller = useMessageScroller()
  const loadTurnProcess = useSessionsStore((s) => s.loadTurnProcess)
  const loadOlderTurns = useSessionsStore((s) => s.loadOlderTurns)
  const onLoadOlder = useCallback((target?: number) => { void loadOlderTurns(sessionId, target) }, [loadOlderTurns, sessionId])
  const { viewportRef, contentRef, visibleTurns, loadEarlier, hasMoreAbove, hasMoreBelow, onScroll, registerTurn, jumpToTurn } = useConversationScroll({
    active, historical, live, windowStart, windowPending: !indexTrusted, hasMoreHistory: windowStart > 0, onLoadOlder, initialScrollState, onSave
  })
  const jumpToRequested = useRef(0)
  const jumpToTurnIndex = useCallback(async (turnIndex: number) => {
    const token = ++jumpToRequested.current
    // A turn outside the loaded window is paged in step by step: one request never reads the whole gap.
    for (let page = 0; page < MAX_JUMP_PAGES; page += 1) {
      const state = useSessionsStore.getState().runtime[sessionId]
      if (!state || token !== jumpToRequested.current || turnIndex >= state.turnStart) break
      const before = state.turnStart
      await loadOlderTurns(sessionId, turnIndex)
      const after = useSessionsStore.getState().runtime[sessionId]
      if (!after || after.instanceId !== state.instanceId || token !== jumpToRequested.current) return
      // Nothing above can be loaded any more; the jump must not spin on a stuck window.
      if (after.turnStart === before) break
    }
    const loaded = useSessionsStore.getState().runtime[sessionId]
    if (!loaded) return
    jumpToTurn(turnIndex - loaded.turnStart)
  }, [jumpToTurn, loadOlderTurns, sessionId])
  const onNeedProcess = useCallback(async (turnId: string) => {
    await loadTurnProcess(sessionId, turnId)
  }, [sessionId, loadTurnProcess])
  // TurnMinimap is memoized: a fresh arrow here would re-render every row on every parent render.
  const onJump = useCallback((turn: number) => { void jumpToTurnIndex(turn) }, [jumpToTurnIndex])

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={viewportRef}
        preserveScrollOnPrepend={false}
        onScroll={onScroll}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('[data-slot="collapsible-trigger"]')) {
            scroller.pauseAutoScroll()
          }
        }}
      >
        <MessageScrollerContent ref={contentRef} className="gap-0">
          {loadError ? (
            // The reader asked for these turns and did not get them: the only useful thing here is a
            // way to ask again.
            <div className={cn(chatColumn, 'flex flex-col items-center gap-1 py-3')}>
              <p role="alert" className="text-center text-xs text-destructive">
                更早的消息加载失败：{loadError}
              </p>
              <Button
                variant="ghost"
                size="xs"
                className="text-xs font-normal text-muted-foreground/80"
                disabled={loadingOlder}
                onClick={() => onLoadOlder()}
              >
                重试
              </Button>
            </div>
          ) : !indexTrusted ? (
            // The window is still the provisional tail: its offset is not known, so there is nothing
            // this reader could page. Clicking asks for the authoritative window instead.
            <div className={cn(chatColumn, 'flex justify-center py-3')}>
              <Button
                variant="ghost"
                size="xs"
                className="text-xs font-normal text-muted-foreground/70"
                disabled={loadingOlder}
                onClick={() => onLoadOlder()}
              >
                正在统计更早轮次…点击重试
              </Button>
            </div>
          ) : hasMoreAbove || windowStart > 0 ? (
            // A reader parked at the very top cannot scroll any further, so the hint is also the way
            // to mount what is already loaded above them.
            <div className={cn(chatColumn, 'flex justify-center py-3')}>
              <Button
                variant="ghost"
                size="xs"
                className="text-xs font-normal text-muted-foreground/80"
                disabled={loadingOlder}
                onClick={() => {
                  if (hasMoreAbove) loadEarlier()
                  else onLoadOlder()
                }}
              >
                {loadingOlder ? '正在加载更早消息…' : '加载更早消息'}
              </Button>
            </div>
          ) : null}
          {visibleTurns.map(({ turn, index, key }) => (
            <MessageScrollerItem
              key={key}
              messageId={key}
              ref={(element) => registerTurn(key, element)}
              data-turn-key={key}
              data-turn-index={windowStart + index}
              className={cn(measuredItem, chatColumn)}
            >
              <TurnView turn={turn} onNeedProcess={onNeedProcess} />
            </MessageScrollerItem>
          ))}
          {hasMoreBelow ? (
            <div className={cn(chatColumn, 'py-3 text-center text-xs text-muted-foreground/60')}>
              向下滚动加载更晚消息
            </div>
          ) : null}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton behavior="smooth" />
      <TurnMinimap items={items} onJump={onJump} />
    </MessageScroller>
  )
}
