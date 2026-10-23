/**
 * Background processes per session, mirrored from main. Pushes are whole per-session snapshots, so a
 * push always replaces what a slower list read returned; reads only fill sessions no push has reached.
 */
import { create } from 'zustand'
import { api, type BackgroundProcessInfo } from '../ipc/api'

interface ProcessState {
  bySession: Record<string, BackgroundProcessInfo[]>
  ensure: (sessionId: string) => void
}

const requested = new Set<string>()
let unsubscribe: (() => void) | null = null
const EMPTY: BackgroundProcessInfo[] = []

export const useProcessStore = create<ProcessState>((set, get) => ({
  bySession: {},
  ensure: (sessionId) => {
    unsubscribe ??= api.processes.onChanged((update) => {
      set((state) => ({ bySession: { ...state.bySession, [update.sessionId]: update.processes } }))
    })
    if (requested.has(sessionId)) return
    requested.add(sessionId)
    void api.processes.list(sessionId).then(
      (processes) => {
        if (!get().bySession[sessionId]) set((state) => ({ bySession: { ...state.bySession, [sessionId]: processes } }))
      },
      () => requested.delete(sessionId)
    )
  }
}))

export function useSessionProcesses(sessionId: string | null): BackgroundProcessInfo[] {
  return useProcessStore((state) => (sessionId ? state.bySession[sessionId] : undefined) ?? EMPTY)
}
