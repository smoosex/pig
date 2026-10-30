/** Read only visible text from another open session's current branch. */
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { sessionState, withSource } from './session-registry'
import { registerSessionReadHost } from '../plugins/pig-session-host'

export function visibleSessionMessages(entries: readonly SessionEntry[]) {
  return entries.flatMap((entry) => {
    if (entry.type !== 'message') return []
    const message = entry.message
    if (message.role !== 'user' && message.role !== 'assistant') return []
    if (message.role === 'assistant' && (message.stopReason !== 'stop' || message.content.some(block => block.type === 'toolCall'))) return []
    const content = message.content
    const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return text ? [{ role: message.role, text: text.slice(0, 8000), truncated: text.length > 8000 }] : []
  })
}

export function registerSessionReader(): void {
  registerSessionReadHost({
    async read(caller, target, offset, limit) {
      if (caller === target) throw new Error('Cannot read the current session')
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid pagination')
      const from = sessionState(caller)
      const to = sessionState(target)
      if (!from.win || from.win !== to.win || from.win.isDestroyed() || from.win.webContents.isDestroyed()) throw new Error('Sessions must be open in the same window')
      const win = from.win
      // leafId and branch are read synchronously in one callback, so they form one snapshot; only the
      // async source load can race a close or replacement, which the check after it rejects.
      const result = await withSource(target, (source) => {
        const leaf = source.leafId()
        const messages = visibleSessionMessages(source.branch())
        return { leaf, messages: messages.slice(offset, offset + limit), total: messages.length }
      })
      if (sessionState(caller) !== from || sessionState(target) !== to || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Session changed while reading')
      return JSON.stringify({ ...result, offset, hasMore: offset + result.messages.length < result.total })
    }
  })
}
