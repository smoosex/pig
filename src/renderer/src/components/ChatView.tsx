import { useCallback, useMemo, useRef } from 'react'
import { toTurn } from '../chat/display-turns'
import { groupTurns } from '../chat/turns'
import { SCROLL_END, TURN_ALIGN, type ScrollSnapshot } from '../chat/scroll-state'
import { useSessionsStore } from '../stores/sessions'
import type { RuntimeState } from '../stores/sessions/types'
import { ConversationViewport } from './chat/ConversationViewport'
import { Empty } from './ui/empty'
import { MessageScrollerProvider } from './ui/message-scroller'

const emptyTurns: RuntimeState['turns'] = []
const emptyMessages: RuntimeState['liveMessages'] = []
const emptyProcess: RuntimeState['processByTurnId'] = {}
const emptyDurations: Record<string, number> = {}
const MAX_SCROLL_SNAPSHOTS = 32

/** Projects the active conversation; scroll state is isolated by session and branch. */
export function ChatView() {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const activeBranchViewId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.branchViewId ?? null) : null
  )
  const turns = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.turns ?? emptyTurns) : emptyTurns
  )
  const liveMessages = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.liveMessages ?? emptyMessages) : emptyMessages
  )
  const processByTurnId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.processByTurnId ?? emptyProcess) : emptyProcess
  )
  const thinkingDurations = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.thinkingDurations ?? emptyDurations) : emptyDurations
  )
  const elapsedByTurnId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.elapsedByTurnId ?? emptyDurations) : emptyDurations
  )
  const streamElapsedMs = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.streamElapsedMs ?? null) : null
  )
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.isStreaming ?? false) : false
  )
  const historical = useMemo(
    () => turns.map((turn) => toTurn(turn, processByTurnId[turn.id] ?? [], elapsedByTurnId[turn.id])),
    [turns, processByTurnId, elapsedByTurnId]
  )
  const live = useMemo(() => {
    if (liveMessages.length === 0) return []
    const grouped = groupTurns(liveMessages, isStreaming, thinkingDurations)
    return grouped.map((turn, index) => ({
      ...turn,
      id: `live-${turns.length + index}`,
      workedMs: index === grouped.length - 1 ? streamElapsedMs ?? undefined : undefined
    }))
  }, [liveMessages, isStreaming, thinkingDurations, streamElapsedMs, turns.length])

  const snapshots = useRef(new Map<string, ScrollSnapshot>())
  const scrollKey = activeSessionId && activeBranchViewId
    ? `${activeSessionId}\u0000${activeBranchViewId}`
    : null
  const saveScrollState = useCallback((state: ScrollSnapshot) => {
    if (!scrollKey) return
    const cache = snapshots.current
    cache.delete(scrollKey)
    cache.set(scrollKey, state)
    // Each snapshot includes row measurements; bound abandoned branch history.
    if (cache.size > MAX_SCROLL_SNAPSHOTS) cache.delete(cache.keys().next().value!)
  }, [scrollKey])
  const initialScrollState = scrollKey ? snapshots.current.get(scrollKey) : undefined

  if (historical.length === 0 && live.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 gap-6">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true" className="size-12 text-primary">
          <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
          <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
        </svg>
        <p className="max-w-xl font-wenkai text-xl text-foreground">
          昨天是段历史，明天是个谜团，而今天是天赐的礼物
        </p>
      </Empty>
    )
  }

  return (
    <MessageScrollerProvider
      key={scrollKey ?? 'none'}
      autoScroll
      scrollMargin={TURN_ALIGN}
      scrollPreviousItemPeek={0}
      scrollEdgeThreshold={SCROLL_END}
      defaultScrollPosition={initialScrollState && !initialScrollState.following ? 'start' : 'end'}
    >
      <ConversationViewport
        historical={historical}
        live={live}
        sessionId={activeSessionId}
        initialScrollState={initialScrollState}
        onSave={saveScrollState}
      />
    </MessageScrollerProvider>
  )
}
