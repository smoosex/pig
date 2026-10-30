/**
 * What each session's agent recorded changing, per file and per turn, read from the session branch in
 * main. It is history, not the worktree: a file edited by hand or by another session never shows up.
 * One summary per session, refreshed whenever its branch tip moves and the run has settled.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { api, type SessionFileChangesSummary, type TurnFileChange } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'
import { useSessionsStore } from './sessions'

interface SessionFileChangesState {
  /** The tip this entry was asked for; a newer tip supersedes it. */
  leafId: string | null
  summary: SessionFileChangesSummary | null
  error: string | null
}

interface FileChangesStore {
  bySession: Record<string, SessionFileChangesState | undefined>
  load: (sessionId: string, leafId: string | null) => void
}

export const useFileChangesStore = create<FileChangesStore>((set, get) => ({
  bySession: {},
  load: (sessionId, leafId) => {
    const current = get().bySession[sessionId]
    if (current && current.leafId === leafId) return
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { leafId, summary: current?.summary ?? null, error: null } } }))
    const settle = (patch: Partial<SessionFileChangesState>) => set((state) => {
      const latest = state.bySession[sessionId]
      if (!latest || latest.leafId !== leafId) return state
      return { bySession: { ...state.bySession, [sessionId]: { ...latest, ...patch } } }
    })
    api.getSessionFileChanges(sessionId).then(
      (summary) => settle({ summary, error: null }),
      (error: unknown) => settle({ error: failureMessage(error) })
    )
  }
}))

/** Keeps the session's summary in step with its branch; a running turn waits for settlement. */
export function useSessionFileChanges(sessionId: string | null | undefined): SessionFileChangesState | undefined {
  const leafId = useSessionsStore((state) => sessionId ? state.runtime[sessionId]?.leafId : undefined)
  const streaming = useSessionsStore((state) => sessionId ? state.runtime[sessionId]?.isStreaming ?? false : false)
  const ready = useSessionsStore((state) => sessionId ? state.openTabs.some((tab) => tab.id === sessionId && tab.loadState === 'ready') : false)
  useEffect(() => {
    if (sessionId && ready && !streaming && leafId !== undefined) useFileChangesStore.getState().load(sessionId, leafId)
  }, [sessionId, ready, streaming, leafId])
  return useFileChangesStore((state) => sessionId ? state.bySession[sessionId] : undefined)
}

export type TurnFileChangesState =
  | { status: 'loading' }
  | { status: 'ready'; files: TurnFileChange[] }
  | { status: 'error'; message: string }

/**
 * One turn's operations with their patches, read only while `enabled`. A new turn starts over; a moved
 * branch tip refreshes in place so an open diff does not flicker while the session keeps running.
 */
export function useTurnFileChanges(sessionId: string, turnId: string, enabled: boolean): TurnFileChangesState {
  const leafId = useSessionsStore((state) => state.runtime[sessionId]?.leafId)
  const [state, setState] = useState<TurnFileChangesState>({ status: 'loading' })
  const key = `${sessionId}\n${turnId}`
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setState({ status: 'loading' })
  }
  useEffect(() => {
    if (!enabled) return
    let current = true
    api.getTurnFileChanges(sessionId, turnId).then(
      (result) => { if (current) setState({ status: 'ready', files: result.files }) },
      (error: unknown) => { if (current) setState({ status: 'error', message: failureMessage(error) }) }
    )
    return () => { current = false }
  }, [sessionId, turnId, enabled, leafId])
  return state
}
