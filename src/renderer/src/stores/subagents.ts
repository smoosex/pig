/**
 * Subagents per parent session, mirrored from main, plus which one the floating card shows.
 *
 * Main pushes whole per-parent snapshots, so a push always replaces what a slower list read
 * returned; reads only fill sessions no push has reached yet.
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api, type SubagentInfo, type SubagentListUpdate } from '../ipc/api'

interface SubagentState {
  bySession: Record<string, SubagentInfo[]>
  /** The card is shown for this parent session with this subagent selected. */
  card: { sessionId: string; id: string } | null
  transcript: { sessionId: string; id: string } | null
  /** A session tab waiting for the user to accept interrupting its background subagents. */
  closing: { tabId: string; running: number } | null
  ensure: (sessionId: string) => void
  apply: (update: SubagentListUpdate) => void
  openCard: (sessionId: string, id: string) => void
  closeCard: () => void
  openTranscript: (sessionId: string, id: string) => void
  closeTranscript: () => void
  confirmClose: (tabId: string, running: number) => void
  cancelClose: () => void
}

const requested = new Set<string>()
let unsubscribe: (() => void) | null = null

export const useSubagentStore = create<SubagentState>((set, get) => ({
  bySession: {},
  card: null,
  transcript: null,
  closing: null,

  ensure: (sessionId) => {
    unsubscribe ??= api.onSubagentsChanged((update) => get().apply(update))
    if (requested.has(sessionId)) return
    requested.add(sessionId)
    void api.listSubagents(sessionId).then(
      (subagents) => {
        if (!get().bySession[sessionId]) set((state) => ({ bySession: { ...state.bySession, [sessionId]: subagents } }))
      },
      () => requested.delete(sessionId)
    )
  },

  apply: (update) => set((state) => ({
    bySession: { ...state.bySession, [update.parentSessionId]: update.subagents }
  })),

  openCard: (sessionId, id) => set({ card: { sessionId, id } }),
  closeCard: () => set({ card: null }),
  openTranscript: (sessionId, id) => set({ transcript: { sessionId, id } }),
  closeTranscript: () => set({ transcript: null }),
  confirmClose: (tabId, running) => set({ closing: { tabId, running } }),
  cancelClose: () => set({ closing: null })
}))

const EMPTY: SubagentInfo[] = []

export function useSessionSubagents(sessionId: string | null): SubagentInfo[] {
  return useSubagentStore((state) => (sessionId ? state.bySession[sessionId] : undefined) ?? EMPTY)
}

export function isSubagentActive(item: SubagentInfo): boolean {
  return item.status === 'queued' || item.status === 'running'
}

export function isSubagentProblem(item: SubagentInfo): boolean {
  return item.status === 'failed' || item.status === 'timeout' || item.status === 'turn_limit' || item.status === 'interrupted'
}

const COLORS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6', 'bg-chart-7']

/** Stable per id, so a subagent keeps its color across lists and restarts. */
export function subagentColor(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]
}

export interface LocatedSubagent {
  sessionId: string
  item: SubagentInfo
}

/** Chat rows know a tool call or subagent id but not which tab's list holds it. */
export function useLocatedSubagent(match: (item: SubagentInfo) => boolean): LocatedSubagent | undefined {
  return useSubagentStore(useShallow((state) => {
    for (const [sessionId, items] of Object.entries(state.bySession)) {
      const item = items.find(match)
      if (item) return { sessionId, item }
    }
    return undefined
  }))
}
