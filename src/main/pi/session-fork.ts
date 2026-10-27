/** Creates Pi's separate-session fork while leaving Pig's source session open. */
import { existsSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ForkPosition, RestoredSessionPrompt } from '../../shared/api'
import { restoreSessionUserPrompt } from './session-user-prompt'

export interface ForkedSessionManager {
  sessionManager: SessionManager
  restoredPrompt?: RestoredSessionPrompt
}

export function forkSessionManager(
  source: SessionManager,
  entryId: string,
  targetCwd: string,
  targetSessionDir: string,
  position: ForkPosition = 'before'
): ForkedSessionManager {
  const entry = source.getEntry(entryId)
  if (!entry) throw new Error(`Entry not found: ${entryId}`)
  const restored = position === 'before' ? restoreSessionUserPrompt(source, entry) : undefined
  const sourcePath = source.getSessionFile()
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error('This session has not been saved yet. Send a message before forking it.')
  }

  const leafId = restored ? restored.parentId : entry.id
  const sessionManager = leafId === null
    ? SessionManager.create(targetCwd, targetSessionDir, { parentSession: sourcePath })
    : SessionManager.open(sourcePath, targetSessionDir, targetCwd)
  if (leafId !== null && !sessionManager.createBranchedSession(leafId)) {
    throw new Error('Failed to create forked session')
  }

  return { sessionManager, ...(restored ? { restoredPrompt: restored.prompt } : {}) }
}
