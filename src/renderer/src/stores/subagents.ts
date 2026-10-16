/**
 * Subagents per parent session, mirrored from main, plus which one the floating card shows.
 *
 * Main pushes whole per-parent snapshots, so a push always replaces what a slower list read
 * returned; reads only fill sessions no push has reached yet.
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api, type SubagentInfo, type SubagentListUpdate } from '../ipc/api'
import { SUBAGENT_ANIMALS, SUBAGENT_COLORS, type SubagentAppearance } from '../../../shared/subagent-appearance'

interface ClearTransition {
  sessionId: string
  phase: 'removing' | 'empty' | 'closing'
}

interface SubagentState {
  bySession: Record<string, SubagentInfo[]>
  /** The card is shown for this parent session with this subagent selected. */
  card: { sessionId: string; id: string } | null
  clearing: ClearTransition | null
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
  clearing: null,
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

  apply: (update) => {
    const state = get()
    let card = state.card
    let clearing = state.clearing
    if (card?.sessionId === update.parentSessionId) {
      const previous = state.bySession[update.parentSessionId] ?? []
      const newlyCleared = update.subagents.some((item) => item.cleared && previous.some((old) => old.id === item.id && !old.cleared))
      const next = update.subagents.find((item) => !item.cleared && isSubagentActive(item))
      if (clearing && clearing.phase !== 'removing' && next) {
        card = { sessionId: update.parentSessionId, id: next.id }
        clearing = null
      } else if (!clearing && newlyCleared) {
        clearing = { sessionId: update.parentSessionId, phase: 'removing' }
      }
    }
    set({ bySession: { ...state.bySession, [update.parentSessionId]: update.subagents }, card, clearing })
    if (clearing && clearing !== state.clearing) {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      const transition = clearing
      setTimeout(() => settleClear(transition), reduced ? 0 : 150)
    }
  },

  openCard: (sessionId, id) => set({ card: { sessionId, id }, clearing: null }),
  closeCard: () => set({ card: null, clearing: null }),
  openTranscript: (sessionId, id) => set({ transcript: { sessionId, id } }),
  closeTranscript: () => set({ transcript: null }),
  confirmClose: (tabId, running) => set({ closing: { tabId, running } }),
  cancelClose: () => set({ closing: null })
}))

/** Timers own only this presentation transition; closing or selecting another card invalidates them. */
function settleClear(transition: ClearTransition): void {
  const state = useSubagentStore.getState()
  if (state.clearing !== transition || state.card?.sessionId !== transition.sessionId) return
  const remaining = (state.bySession[transition.sessionId] ?? []).filter((item) => !item.cleared)
  const next = remaining.find((item) => item.id === state.card?.id) ?? remaining.find(isSubagentActive) ?? remaining.at(-1)
  if (next) {
    useSubagentStore.setState({ card: { sessionId: transition.sessionId, id: next.id }, clearing: null })
    return
  }
  const empty: ClearTransition = { ...transition, phase: 'empty' }
  useSubagentStore.setState({ clearing: empty })
  setTimeout(() => {
    if (useSubagentStore.getState().clearing !== empty) return
    const closing: ClearTransition = { ...empty, phase: 'closing' }
    useSubagentStore.setState({ clearing: closing })
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    setTimeout(() => {
      if (useSubagentStore.getState().clearing === closing) useSubagentStore.getState().closeCard()
    }, reduced ? 0 : 150)
  }, 100)
}

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

const BACKGROUND_COLORS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6', 'bg-chart-7']
const ICON_COLORS = ['text-chart-1', 'text-chart-2', 'text-chart-3', 'text-chart-4', 'text-chart-5', 'text-chart-6', 'text-chart-7']

/** Older indexes have no assigned appearance; derive one without changing it on every render. */
export function subagentAppearance(item: SubagentInfo): SubagentAppearance {
  if (item.appearance) return item.appearance
  let hash = 0
  for (const char of item.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return { animal: SUBAGENT_ANIMALS[hash % SUBAGENT_ANIMALS.length], color: SUBAGENT_COLORS[hash % SUBAGENT_COLORS.length] }
}

export function subagentColor(item: SubagentInfo, foreground = false): string {
  return (foreground ? ICON_COLORS : BACKGROUND_COLORS)[subagentAppearance(item).color - 1]
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
