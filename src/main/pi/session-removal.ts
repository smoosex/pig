/**
 * Removing a session deletes Pi's JSONL and Pig's per-session data together. The loader stays a
 * reader of Pi's files only; Pig's own data directory belongs to this layer.
 */
import { removeProjectDir, removeSessionFile } from './session-loader'
import { removeSessionCapabilities } from './session-capabilities'

export async function removeSession(path: string): Promise<void> {
  const sessionId = await removeSessionFile(path)
  if (sessionId) await removeSessionCapabilities(sessionId)
}

export async function removeProjectSessions(cwd: string): Promise<void> {
  await Promise.all((await removeProjectDir(cwd)).map(removeSessionCapabilities))
}
