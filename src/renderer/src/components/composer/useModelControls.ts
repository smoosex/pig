import type { SessionControls } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'

/** Serialize toolbar mutations per session; every reply reaches the session instance that asked. */
export function useModelControls(sessionId: string | null) {
  const pending = useSessionsStore((s) =>
    sessionId ? s.runtime[sessionId]?.controlsPending ?? false : false)
  const error = useSessionsStore((s) =>
    sessionId ? s.runtime[sessionId]?.controlsError ?? null : null)

  async function run(operation: () => Promise<SessionControls>): Promise<boolean> {
    const target = sessionId
    const started = target ? useSessionsStore.getState().runtime[target] : undefined
    if (!target || !started || started.controlsPending) return false
    const startedAt = started.instanceId
    // Closing the session builds a new runtime: a late write must not touch the new instance's flags.
    const isInstance = () => useSessionsStore.getState().runtime[target]?.instanceId === startedAt
    const write = (status: { controlsPending: boolean; controlsError: string | null }): void => {
      if (isInstance()) useSessionsStore.getState().setControlsStatus(target, status)
    }
    let failure: string | null = null
    write({ controlsPending: true, controlsError: null })
    try {
      const controls = await operation()
      if (!isInstance()) return false
      useSessionsStore.getState().applyControls(target, controls)
      return true
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      write({ controlsPending: false, controlsError: failure })
    }
  }

  return { pending, error, run }
}

export type ModelControlActions = ReturnType<typeof useModelControls>
