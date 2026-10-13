/**
 * The model catalog every picker reads.
 *
 * It lives outside the settings store on purpose: settings load as a whole snapshot and overwrite
 * what they hold, so a catalog pushed while a settings read was in flight would be replaced by the
 * older one that read carried. Content revisions reject stale lists; intervening pushes supersede
 * reads even when the list revision is unchanged, because refresh-state events share that revision.
 */
import { create } from 'zustand'
import { api, type ModelCatalog } from '../ipc/api'

interface CatalogStore extends ModelCatalog {
  error: string | null
  loading: boolean
  /** Concurrent readers share a request; failures are exposed to the app's retryable error UI. */
  load: () => Promise<void>
  apply: (catalog: ModelCatalog) => void
}

let reading: Promise<void> | null = null
let pushes = 0

export const useModelCatalogStore = create<CatalogStore>((set, get) => ({
  models: [],
  revision: 0,
  refreshing: false,
  error: null,
  loading: false,

  load: () => {
    if (reading) return reading
    const startedAt = pushes
    set({ loading: true })
    reading = api.getModelCatalog().then(
      (catalog) => {
        // List revisions do not order refresh-state changes. Any intervening push supersedes a read.
        if (startedAt === pushes && catalog.revision >= get().revision) set(catalog)
        set({ error: null })
      },
      (error: unknown) => {
        // IPC initialization/auth/file failures are a UI boundary: retain data, show failure + retry.
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    ).finally(() => {
      reading = null
      set({ loading: false })
    })
    return reading
  },

  apply: (catalog) => {
    if (catalog.revision < get().revision) return
    pushes += 1
    set(catalog)
  }
}))
