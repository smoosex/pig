import { useEffect, useRef, useState } from 'react'
import type { SessionControls } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'

/** Serialize toolbar mutations and ignore replies for a closed or replaced session. */
export function useModelControls(sessionId: string | null) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<object | null>(null)

  useEffect(() => {
    request.current = null
    setPending(false)
    setError(null)
    return () => { request.current = null }
  }, [sessionId])

  async function run(operation: () => Promise<SessionControls>): Promise<boolean> {
    const runtime = sessionId ? useSessionsStore.getState().runtime[sessionId] : undefined
    if (!sessionId || !runtime || request.current) return false
    const instanceId = runtime.instanceId
    const token = {}
    request.current = token
    setPending(true)
    setError(null)
    const isCurrent = () => request.current === token &&
      useSessionsStore.getState().runtime[sessionId]?.instanceId === instanceId
    try {
      const controls = await operation()
      if (!isCurrent()) return false
      useSessionsStore.getState().applyControls(sessionId, controls)
      return true
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (request.current === token) {
        request.current = null
        setPending(false)
      }
    }
  }

  return { pending, error, run }
}

export type ModelControlActions = ReturnType<typeof useModelControls>
