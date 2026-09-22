import { useEffect } from 'react'
import { api } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'

/** A name appended past the prefix its listing read arrives after the rows painted with a first message. */
export function useSessionNames(): void {
  useEffect(() => api.onSessionNames((updates) => {
    useSessionsStore.getState().applySessionNames(updates)
  }), [])
}
