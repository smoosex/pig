/** Collect only persisted branch-local reflections; replay repairs a missed inbox write after restart. */
import { statSync } from 'node:fs'
import { longTermMemoryPath } from '../paths'
import type { Entry } from '../session-ledger/types'
import { collectMemoryCandidates } from './candidates'
import { MemoryCandidateStore } from './store'

export interface CandidateContext {
  cwd: string
  sessionManager: {
    getSessionId?: () => string
    getSessionFile?: () => string | undefined
    getBranch: () => unknown
  }
}

export function collectPersistedMemoryCandidates(ctx: CandidateContext): void {
  const sessionId = ctx.sessionManager.getSessionId?.()
  const sessionFile = ctx.sessionManager.getSessionFile?.()
  // The SDK synchronously persists appendEntry once a conversation exists. In-memory sessions
  // and not-yet-created files must not create cross-session copies of ephemeral state.
  if (!sessionId || !sessionFile) return
  try {
    if (!statSync(sessionFile).isFile()) throw new Error('Memory source is not a session file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const collection = collectMemoryCandidates({ sessionId, sessionFile, cwd: ctx.cwd }, ctx.sessionManager.getBranch() as Entry[])
  if (collection.candidates.length === 0) return
  const store = new MemoryCandidateStore(longTermMemoryPath())
  try {
    store.enqueue(collection.candidates)
  } finally {
    store.close()
  }
}
