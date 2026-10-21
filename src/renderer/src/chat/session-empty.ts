import type { RuntimeState } from '../stores/sessions/types'

/** A session with nothing to show yet: the transcript greets instead, and the composer sits centred under it. */
export function isSessionEmpty(runtime: RuntimeState | undefined): boolean {
  if (!runtime) return true
  return runtime.turns.length === 0 && runtime.liveMessages.length === 0 && !runtime.bashExecution &&
    runtime.turnStart === 0 && runtime.turnIndexTrusted && !runtime.turnError
}
