import type { BrowserWindow } from 'electron'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { PastedTextDisplayMetadata } from '../../shared/pasted-text'

const bridged = new WeakSet<AgentSession>()
const pendingPastedText = new WeakMap<AgentSession, PastedTextDisplayMetadata>()

export function setPendingPastedText(session: AgentSession, metadata: PastedTextDisplayMetadata): void {
  pendingPastedText.set(session, metadata)
}

export function clearPendingPastedText(session: AgentSession): void {
  pendingPastedText.delete(session)
}

export function bridgeEvents(
  session: AgentSession,
  sessionId: string,
  win: BrowserWindow
): () => void {
  if (bridged.has(session)) return () => {}
  bridged.add(session)

  const unsubscribe = session.subscribe((event) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const metadata = pendingPastedText.get(session)
    const enriched =
      metadata &&
      (event.type === 'message_start' || event.type === 'message_end') &&
      event.message?.role === 'user'
        ? {
            ...event,
            message: {
              ...event.message,
              pastedText: metadata
            }
          }
        : event
    win.webContents.send('pi:event', { sessionId, event: enriched })
  })
  return unsubscribe
}
