import { useEffect, useRef, useState } from 'react'
import { api } from '../../ipc/api'
import { errorMessage } from './project-action'

type Section = 'projects' | 'chats'
type PrefField = 'projectsCollapsed' | 'chatsCollapsed' | 'read'

export function useSidebarPreferences() {
  const [collapsed, setCollapsed] = useState({ projects: false, chats: false })
  const [error, setError] = useState<string | null>(null)
  const touched = useRef(new Set<Section>())
  const writes = useRef(Promise.resolve())
  const mounted = useRef(false)
  /**
   * Failures are per field and a success clears only the field it wrote: `setSidebarPrefs` merges one field
   * at a time, so saving the chats section says nothing about the projects one. Oldest failure first, so
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
        setCollapsed((current) => ({
          projects: touched.current.has('projects') ? current.projects : prefs.projectsCollapsed,
          chats: touched.current.has('chats') ? current.chats : prefs.chatsCollapsed
        }))
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

  const setSectionCollapsed = (section: Section, value: boolean) => {
    touched.current.add(section)
    setCollapsed((current) => ({ ...current, [section]: value }))
    const field: PrefField = section === 'projects' ? 'projectsCollapsed' : 'chatsCollapsed'
    const patch = section === 'projects' ? { projectsCollapsed: value } : { chatsCollapsed: value }
    writes.current = writes.current
      .then(() => api.setSidebarPrefs(patch))
      .then(
        () => {
          failures.current.delete(field)
          // A write that landed proves the file can be reached, so it answers a read that failed as well.
          failures.current.delete('read')
          publishError()
        },
        (error: unknown) => {
          // Re-inserting keeps the map ordered oldest first, so a repeated failure becomes the one shown.
          failures.current.delete(field)
          failures.current.set(field, errorMessage(error))
          publishError()
        }
      )
  }

  return { collapsed, setSectionCollapsed, error }
}
