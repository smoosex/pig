import type { BrowserWindow } from 'electron'
import type { AgentSession } from '@earendil-works/pi-coding-agent'

const bridged = new WeakSet<AgentSession>()

export function bridgeEvents(
  session: AgentSession,
  sessionId: string,
  win: BrowserWindow
): () => void {
  if (bridged.has(session)) return () => {}
  bridged.add(session)

  const unsubscribe = session.subscribe((event) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('pi:event', { sessionId, event })
  })
  return unsubscribe
}