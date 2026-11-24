/**
 * Zero-dependency coordination between OM's idle proactive compaction and incoming prompts:
 * - Proactive OM compaction yields immediately (`abortCompaction()`) when a new prompt arrives.
 * - Explicit manual compaction stays running while the incoming prompt waits for `compaction_end`
 *   (cancelling cleanly if `signal` aborts via session stop/close).
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'

const runtimesKey = Symbol.for('pig:observational-memory:runtimes')

export function isProactiveMemoryCompaction(sessionId: string): boolean {
  const map = (globalThis as Record<symbol, Map<string, { proactiveCompactionRunning?: boolean }> | undefined>)[runtimesKey]
  return map?.get(sessionId)?.proactiveCompactionRunning === true
}

export async function awaitCompactionBeforePrompt(
  sessionId: string,
  agentSession: Pick<AgentSession, 'isCompacting' | 'abortCompaction' | 'subscribe'>,
  signal?: AbortSignal
): Promise<void> {
  if (!agentSession.isCompacting) return
  if (isProactiveMemoryCompaction(sessionId)) {
    agentSession.abortCompaction()
  }
  if (!agentSession.isCompacting) return

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      unsubscribe()
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Prompt cancelled while waiting for compaction', 'AbortError'))
    }
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type === 'compaction_end' || !agentSession.isCompacting) {
        signal?.removeEventListener('abort', onAbort)
        unsubscribe()
        resolve()
      }
    })
    if (!agentSession.isCompacting) {
      unsubscribe()
      resolve()
      return
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
