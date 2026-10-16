/**
 * Shared settings snapshot, refreshed after operations and main pushes without committing stale reads.
 * Mutations take the global UI lock; read-only probes may opt out and use row locks in the pane.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { api, type McpSettingsState } from '../ipc/api'

interface Store {
  state: McpSettingsState
  loaded: boolean
  busy: boolean
  error: string | null
  load(): Promise<void>
  run<T>(operation: () => Promise<T>, options?: { blocking?: boolean }): Promise<T | undefined>
}
export const useToolSettingsStore = create<Store>((set) => {
  let reading: Promise<void> | undefined
  let revision = 0
  let operations = 0
  let dirty = false
  const load = (): Promise<void> => {
    revision++
    dirty = true
    if (reading) return reading
    reading = (async () => {
      try {
        while (dirty) {
          dirty = false
          const at = revision
          const state = await api.getMcpSettings()
          if (at !== revision) {
            dirty = true
            continue
          }
          set({ state, loaded: true, error: null })
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        reading = undefined
      }
    })()
    return reading
  }
  return {
    state: { servers: [], pendingSessions: [] },
    loaded: false,
    busy: false,
    error: null,
    load,
    async run<T>(operation: () => Promise<T>, { blocking = true }: { blocking?: boolean } = {}) {
      revision++
      if (blocking) operations++
      set({ busy: operations > 0, error: null })
      try {
        const result = await operation()
        revision++
        await load()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set({ error: message })
        toast.error(message)
        return undefined
      } finally {
        if (blocking) operations--
        set({ busy: operations > 0 })
      }
    }
  }
})
