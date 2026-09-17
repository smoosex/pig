import { Activity, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toTurn } from '../chat/display-turns'
import { groupTurns } from '../chat/turns'
import { SCROLL_END, TURN_ALIGN, type ScrollSnapshot } from '../chat/scroll-state'
import { useSessionsStore } from '../stores/sessions'
import type { RuntimeState } from '../stores/sessions/types'
import { ConversationViewport } from './chat/ConversationViewport'
import { SessionGreeting } from './SessionGreeting'
import { MessageScrollerProvider } from './ui/message-scroller'

const emptyTurns: RuntimeState['turns'] = []
const emptySummary: RuntimeState['turnSummary'] = []
const emptyMessages: RuntimeState['liveMessages'] = []
const emptyProcess: RuntimeState['processByTurnId'] = {}
const emptyDurations: Record<string, number> = {}
const MAX_SCROLL_SNAPSHOTS = 32
const MAX_RETAINED_PANES = 3

type SnapshotCache = Map<string, ScrollSnapshot>

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Keep the active pane and the two most recently visited panes mounted. */
function useRetainedSessionIds(openTabs: { sessionId: string }[], activeSessionId: string | null): string[] {
  const openIds = useMemo(() => new Set(openTabs.map((tab) => tab.sessionId)), [openTabs])
  const [recentIds, setRecentIds] = useState<string[]>([])

  useEffect(() => {
    setRecentIds((previous) => {
      const next = previous.filter((id) => openIds.has(id))
      if (activeSessionId && openIds.has(activeSessionId)) {
        const existing = next.indexOf(activeSessionId)
        if (existing !== -1) next.splice(existing, 1)
        next.unshift(activeSessionId)
      }
      const limited = next.slice(0, MAX_RETAINED_PANES)
      return sameIds(previous, limited) ? previous : limited
    })
  }, [activeSessionId, openIds])

  return useMemo(() => {
    const retained = recentIds.filter((id) => openIds.has(id))
    if (activeSessionId && openIds.has(activeSessionId) && !retained.includes(activeSessionId)) {
      retained.unshift(activeSessionId)
    }
    return retained.slice(0, MAX_RETAINED_PANES)
  }, [activeSessionId, openIds, recentIds])
}

/** A session-owned conversation tree; switching tabs only changes Activity visibility. */
const SessionChatPane = memo(function SessionChatPane({
  sessionId,
  active,
  snapshots,
  forceInitialBottom
}: {
  sessionId: string
  active: boolean
  snapshots: SnapshotCache
  forceInitialBottom: boolean
}) {
  const branchViewId = useSessionsStore((s) => s.runtime[sessionId]?.branchViewId ?? null)
  const turns = useSessionsStore((s) => s.runtime[sessionId]?.turns ?? emptyTurns)
  const turnStart = useSessionsStore((s) => s.runtime[sessionId]?.turnStart ?? 0)
  const turnSummary = useSessionsStore((s) => s.runtime[sessionId]?.turnSummary ?? emptySummary)
  const turnIndexTrusted = useSessionsStore((s) => s.runtime[sessionId]?.turnIndexTrusted ?? true)
  const turnLoading = useSessionsStore((s) => s.runtime[sessionId]?.turnLoading ?? false)
  const turnError = useSessionsStore((s) => s.runtime[sessionId]?.turnError ?? null)
  const liveMessages = useSessionsStore((s) => s.runtime[sessionId]?.liveMessages ?? emptyMessages)
  const processByTurnId = useSessionsStore((s) => s.runtime[sessionId]?.processByTurnId ?? emptyProcess)
  const thinkingDurations = useSessionsStore((s) => s.runtime[sessionId]?.thinkingDurations ?? emptyDurations)
  const elapsedByTurnId = useSessionsStore((s) => s.runtime[sessionId]?.elapsedByTurnId ?? emptyDurations)
  const streamElapsedMs = useSessionsStore((s) => s.runtime[sessionId]?.streamElapsedMs ?? null)
  const isStreaming = useSessionsStore((s) => s.runtime[sessionId]?.isStreaming ?? false)

  const historical = useMemo(
    () => turns.map((turn) => toTurn(turn, processByTurnId[turn.id] ?? [], elapsedByTurnId[turn.id])),
    [turns, processByTurnId, elapsedByTurnId]
  )
  const live = useMemo(() => {
    if (liveMessages.length === 0) return []
    const grouped = groupTurns(liveMessages, isStreaming, thinkingDurations)
    return grouped.map((turn, index) => ({
      ...turn,
      id: turn.id ?? `live:${turn.renderKey ?? index}`,
      workedMs: index === grouped.length - 1 ? streamElapsedMs ?? undefined : undefined
    }))
  }, [liveMessages, isStreaming, thinkingDurations, streamElapsedMs])

  const scrollKey = branchViewId ? `${sessionId}\u0000${branchViewId}` : null
  const saveScrollState = useCallback((state: ScrollSnapshot) => {
    if (!scrollKey) return
    snapshots.delete(scrollKey)
    snapshots.set(scrollKey, state)
    // Bound abandoned branch history.
    if (snapshots.size > MAX_SCROLL_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
  }, [scrollKey, snapshots])
  const initialScrollState = !forceInitialBottom && scrollKey ? snapshots.get(scrollKey) : undefined
  // Captured once: MessageScroller re-applies a changed default and would move a live pane.
  const defaultScrollPosition = useRef<'start' | 'end'>(
    initialScrollState && !initialScrollState.following ? 'start' : 'end'
  ).current

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      {historical.length === 0 && live.length === 0 && turnStart === 0 && turnIndexTrusted && !turnError ? (
        <SessionGreeting />
      ) : (
        <MessageScrollerProvider
          key={branchViewId ?? 'none'}
          autoScroll={active}
          scrollMargin={TURN_ALIGN}
          scrollPreviousItemPeek={0}
          scrollEdgeThreshold={SCROLL_END}
          defaultScrollPosition={defaultScrollPosition}
        >
          <ConversationViewport
            active={active}
            historical={historical}
            live={live}
            sessionId={sessionId}
            branchViewId={branchViewId ?? 'unresolved'}
            windowStart={turnStart}
            indexTrusted={turnIndexTrusted}
            loadingOlder={turnLoading}
            loadError={turnError}
            summary={turnSummary}
            initialScrollState={initialScrollState}
            onSave={saveScrollState}
          />
        </MessageScrollerProvider>
      )}
    </div>
  )
})

/** Projects open conversations while retaining a bounded set of mounted panes. */
export function ChatView() {
  const openTabs = useSessionsStore((s) => s.openTabs)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const retainedSessionIds = useRetainedSessionIds(openTabs, activeSessionId)
  const snapshots = useRef<SnapshotCache>(new Map()).current
  const openIds = useMemo(() => new Set(openTabs.map((tab) => tab.sessionId)), [openTabs])
  const previousOpenIds = useRef<Set<string>>(new Set())
  const newlyOpenedIds = new Set([...openIds].filter((id) => !previousOpenIds.current.has(id)))

  useLayoutEffect(() => {
    for (const sessionId of openIds) {
      if (previousOpenIds.current.has(sessionId)) continue
      const prefix = `${sessionId}\u0000`
      for (const key of snapshots.keys()) {
        if (key.startsWith(prefix)) snapshots.delete(key)
      }
    }
    previousOpenIds.current = openIds
  }, [openIds, snapshots])

  return (
    <div className="relative min-h-0 flex-1">
      {retainedSessionIds.map((sessionId) => (
        <Activity
          key={sessionId}
          name={`session-${sessionId}`}
          mode={sessionId === activeSessionId ? 'visible' : 'hidden'}
        >
          <SessionChatPane
            sessionId={sessionId}
            active={sessionId === activeSessionId}
            snapshots={snapshots}
             forceInitialBottom={newlyOpenedIds.has(sessionId)}
          />
        </Activity>
      ))}
    </div>
  )
}
