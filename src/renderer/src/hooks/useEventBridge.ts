import { useEffect } from 'react'
import { subscribeSessionEvents } from '../chat/session-events'

export function useEventBridge(): void {
  useEffect(subscribeSessionEvents, [])
}
