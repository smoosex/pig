/** Durable ancestry checkpoints repair interrupted collection without replaying processed reflections. */
import { existsSync, statSync } from 'node:fs'
import { longTermMemoryPath } from '../paths'
import { isReflectionsRecordedEntry, type Entry } from '../session-ledger/types'
import { collectMemoryCandidates } from './candidates'
import { MemoryCandidateStore } from './store'

export interface CandidateContext {
  cwd: string
  sessionManager: {
    getSessionId?: () => string
    getSessionFile?: () => string | undefined
    getLeafId?: () => string | null
    getEntry?: (id: string) => (Entry & { parentId: string | null }) | undefined
    getBranch: () => unknown
  }
}

export function collectPersistedMemoryCandidates(ctx: CandidateContext): void {
  const sessionId = ctx.sessionManager.getSessionId?.()
  const sessionFile = ctx.sessionManager.getSessionFile?.()
  // Only persisted conversations may advance durable collection progress.
  if (!sessionId || !sessionFile) return
  try {
    if (!statSync(sessionFile).isFile()) throw new Error('Memory source is not a session file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const { getLeafId, getEntry } = ctx.sessionManager
  if (!getLeafId || !getEntry) throw new Error('Memory collection requires session ancestry access')
  const path = longTermMemoryPath()
  let store = existsSync(path) ? new MemoryCandidateStore(path) : undefined
  try {
    const entryIds: string[] = []
    const seen = new Set<string>()
    const reflections = new Set<string>()
    let id = getLeafId.call(ctx.sessionManager)
    // A checkpoint is branch-local: walking parents naturally stops at a shared ancestor,
    // not at a file offset that could belong to an abandoned sibling branch.
    while (id && !store?.collectionEntryProcessed(sessionId, id)) {
      if (seen.has(id)) throw new Error('Cyclic memory source branch')
      seen.add(id)
      const entry = getEntry.call(ctx.sessionManager, id)
      if (!entry) throw new Error('Missing memory source entry')
      entryIds.push(id)
      if (isReflectionsRecordedEntry(entry)) reflections.add(id)
      id = entry.parentId
    }
    if (!entryIds.length) return
    if (!store && !reflections.size) return
    store ??= new MemoryCandidateStore(path)
    // Evidence validation needs ancestors, but only unseen reflection payloads are derived.
    // No branch reconstruction at all on an unchanged restart or a message-only suffix.
    const candidates = reflections.size ? collectMemoryCandidates(
      { sessionId, sessionFile, cwd: ctx.cwd }, ctx.sessionManager.getBranch() as Entry[], reflections,
    ).candidates : []
    store.enqueue(candidates, { sessionId, entryIds })
  } finally {
    store?.close()
  }
}
