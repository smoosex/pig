import { useEffect } from 'react'
import { api } from '../ipc/api'
import { useModelCatalogStore } from '../stores/model-catalog'

/**
 * The model catalog is app state, not a session's: main pushes it whenever a refresh changes it, so
 * every picker in every pane reads the one copy and none of them can be older than the app's.
 *
 * The first read and the subscription are registered together: a push that lands while that read is
 * in flight is newer than what it carries, and the store drops the older of the two.
 */
export function useModelCatalog(): void {
  useEffect(() => {
    const store = useModelCatalogStore.getState()
    const unsubscribe = api.onModelCatalog((catalog) => useModelCatalogStore.getState().apply(catalog))
    void store.load()
    return unsubscribe
  }, [])
}
