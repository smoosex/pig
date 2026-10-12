/** Creates Pi's separate-session fork while leaving Pig's source session open. */
import { existsSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { RestoredSessionPrompt } from '../../shared/api'
import { restoreSessionUserPrompt } from './session-user-prompt'

export interface ForkedSessionManager {
  sessionManager: SessionManager
  restoredPrompt: RestoredSessionPrompt
}

export function forkSessionManager(
  source: SessionManager,
  userEntryId: string,
  targetCwd: string,
  targetSessionDir: string
): ForkedSessionManager {
  const entry = source.getEntry(userEntryId)
  if (!entry) throw new Error(`Entry not found: ${userEntryId}`)
  const restored = restoreSessionUserPrompt(source, entry)
  const sourcePath = source.getSessionFile()
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error('This session has not been saved yet. Send a message before forking it.')
  }

  const sessionManager = restored.parentId === null
    ? SessionManager.create(targetCwd, targetSessionDir, { parentSession: sourcePath })
    : SessionManager.open(sourcePath, targetSessionDir, targetCwd)
  if (restored.parentId !== null && !sessionManager.createBranchedSession(restored.parentId)) {
    throw new Error('Failed to create forked session')
  }

  return { sessionManager, restoredPrompt: restored.prompt }
}
