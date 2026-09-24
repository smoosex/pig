import { useEffect, useRef, useState } from 'react'
import { api } from '../../ipc/api'
import type { SidebarTab } from '../../../../shared/api'
import { errorMessage } from './project-action'

type PrefField = 'sidebarTab' | 'read'

export function useSidebarPreferences() {
  const [tab, setTabState] = useState<SidebarTab>('projects')
  const [error, setError] = useState<string | null>(null)
  const touched = useRef(false)
  const writes = useRef(Promise.resolve())
  const mounted = useRef(false)
  /**
   * Failures are per field and a success clears only the field it wrote. Oldest failure first, so
   * the newest unresolved one is what shows.
   */
  const failures = useRef(new Map<PrefField, string>())

  const publishError = () => {
    if (mounted.current) setError([...failures.current.values()].at(-1) ?? null)
  }

  useEffect(() => {
    let disposed = false
    mounted.current = true
    void api.getSidebarPrefs().then(
      (prefs) => {
        if (disposed) return
        if (!touched.current) setTabState(prefs.sidebarTab)
      },
      (error: unknown) => {
        if (disposed) return
        failures.current.set('read', errorMessage(error))
        setError(errorMessage(error))
      }
    )
    return () => {
      disposed = true
      mounted.current = false
    }
  }, [])

  const setTab = (next: SidebarTab) => {
    touched.current = true
    setTabState(next)
    const patch = { sidebarTab: next }
    writes.current = writes.current
      .then(() => api.setSidebarPrefs(patch))
      .then(
        () => {
          failures.current.delete('sidebarTab')
          // A write that landed proves the file can be reached, so it answers a read that failed as well.
          failures.current.delete('read')
          publishError()
        },
        (error: unknown) => {
          // Re-inserting keeps the map ordered oldest first, so a repeated failure becomes the one shown.
          failures.current.delete('sidebarTab')
          failures.current.set('sidebarTab', errorMessage(error))
          publishError()
        }
      )
  }

  return { tab, setTab, error }
}
