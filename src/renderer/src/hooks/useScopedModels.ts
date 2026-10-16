import { useEffect } from 'react'
import { api } from '../ipc/api'
import { useModelCatalogStore } from '../stores/model-catalog'
import { useScopedModelsStore } from '../stores/scoped-models'

export function useScopedModels(active: boolean) {
  const scope = useScopedModelsStore()
  const revision = useModelCatalogStore((s) => s.revision)
  useEffect(() => {
    if (!active) return
    void scope.load()
    return api.onScopedModelsChanged(() => { void scope.load() })
  }, [active, revision, scope.load])
  return scope
}
