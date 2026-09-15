import { useEffect } from 'react'
import { api } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'

/** A session's branch index is built after its first paint; this is how the window learns about it. */
export function useSessionWindows(): void {
  useEffect(() => api.onSessionWindow((update) => {
    useSessionsStore.getState().applySessionWindow(update)
  }), [])
}
