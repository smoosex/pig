import { useEffect, useRef, useState } from 'react'
import { api } from '../../ipc/api'
import { errorMessage } from './project-action'

type Section = 'projects' | 'chats'

export function useSidebarPreferences() {
  const [collapsed, setCollapsed] = useState({ projects: false, chats: false })
  const [error, setError] = useState<string | null>(null)
  const touched = useRef(new Set<Section>())
  const writes = useRef(Promise.resolve())
  const mounted = useRef(false)

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
        if (!disposed) setError(errorMessage(error))
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
    setError(null)
    const patch = section === 'projects' ? { projectsCollapsed: value } : { chatsCollapsed: value }
    writes.current = writes.current
      .then(() => api.setSidebarPrefs(patch))
      .then(
        () => {},
        (error: unknown) => {
          if (mounted.current) setError(errorMessage(error))
        }
      )
  }

  return { collapsed, setSectionCollapsed, error }
}
