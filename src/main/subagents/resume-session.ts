import { readFileSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'

/** Validate immediately before opening: the SDK otherwise creates a new session for an empty file. */
export function openResumeSession(path: string, sessionDir: string): SessionManager {
  const content = readFileSync(path, 'utf8')
  const first = content.split('\n').find((line) => line.trim())
  let header: { type?: unknown; id?: unknown }
  try { header = JSON.parse(first ?? '') } catch { throw new Error('Cannot resume this subagent: its original transcript is invalid') }
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id) {
    throw new Error('Cannot resume this subagent: its original transcript is invalid')
  }
  const manager = SessionManager.open(path, sessionDir)
  if (manager.getHeader()?.id !== header.id || !manager.getEntries().some((entry) => entry.type === 'message')) {
    throw new Error('Cannot resume this subagent: its original transcript is invalid')
  }
  return manager
}
