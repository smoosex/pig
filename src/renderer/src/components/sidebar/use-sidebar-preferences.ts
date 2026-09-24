import { useEffect, useRef, useState } from 'react'
import { api } from '../../ipc/api'
import type { SidebarTab } from '../../../../shared/api'
import { errorMessage } from './project-action'

type PrefField = 'sidebarTab' | 'read'

const SIDEBAR_PREFS_TIMEOUT_MS = 2000

export function useSidebarPreferences() {
  const [tab, setTabState] = useState<SidebarTab>('projects')
  const [ready, setReady] = useState(false)
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
    let timedOut = false
    mounted.current = true
    const timeout = setTimeout(() => {
      timedOut = true
      if (!disposed) setReady(true)
    }, SIDEBAR_PREFS_TIMEOUT_MS)
    void api.getSidebarPrefs().then(
      (prefs) => {
        // The fallback already chose the pane; a late read must not move it.
        if (disposed || timedOut) return
        clearTimeout(timeout)
        if (!touched.current) setTabState(prefs.sidebarTab)
        setReady(true)
      },
      (error: unknown) => {
        if (disposed || timedOut) return
        clearTimeout(timeout)
        failures.current.set('read', errorMessage(error))
        setError(errorMessage(error))
        setReady(true)
      }
    )
    return () => {
      disposed = true
      clearTimeout(timeout)
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

  return { tab, setTab, ready, error }
}
