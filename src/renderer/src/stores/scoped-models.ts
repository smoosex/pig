/** Scope data is re-read on picker open, including changes made by the standalone Pi CLI. */
import { create } from 'zustand'
import { api } from '../ipc/api'
import type { ScopedModelSettings } from '../../../shared/api'

let generation = 0

export const useScopedModelsStore = create<ScopedModelSettings & {
  mode: 'all' | 'scoped'
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  setMode: (mode: 'all' | 'scoped') => void
}>((set) => ({
  patterns: [],
  selections: [],
  missingProviderPatterns: [],
  models: [],
  warnings: [],
  mode: 'scoped',
  loaded: false,
  error: null,
  setMode: (mode) => set({ mode }),
  load: async () => {
    const request = ++generation
    try {
      const settings = await api.getScopedModels()
      if (request === generation) set({ ...settings, loaded: true, error: null })
    } catch (error) {
      if (request === generation) set({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}))
