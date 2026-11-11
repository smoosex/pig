/** Only the owning UI main frame may bookmark or locate a persisted reply. Lists span all chats. */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { bookmarks } from '../bookmarks'
import { sessionState, withSource } from '../pi/session-registry'
import { isChatCwd } from '../chats'
import { replyBookmarkId } from '../../shared/bookmarks'

function assertUi(event: IpcMainInvokeEvent): BrowserWindow {
  const win = windowForEvent(event)
  assertBrowserSender(event, win)
  return win
}

function ownedSession(event: IpcMainInvokeEvent, sessionId: string) {
  const win = assertUi(event)
  const session = sessionState(sessionId)
  if (session.win !== win) throw new Error('Session belongs to another window')
  return session
}

function changed(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('bookmarks:changed')
  }
}

function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 300) throw new Error('Invalid bookmark identifier')
}

export function registerBookmarksIpc(): void {
  ipcMain.handle('bookmarks:list', event => { assertUi(event); return bookmarks.list() })
  ipcMain.handle('bookmarks:add', async (event, sessionId: string, turnId: string, entryId: string, title: string) => {
    for (const id of [sessionId, turnId, entryId]) requireId(id)
    if (typeof title !== 'string' || title.length > 1000) throw new Error('Invalid bookmark title')
    const owner = ownedSession(event, sessionId)
    const file = 'agentSession' in owner ? owner.agentSession.sessionFile
      : owner.kind === 'file' ? owner.path : owner.sessionManager.getSessionFile()
    if (!file) throw new Error('Reply has not been saved')
    const details = await withSource(sessionId, source => {
      const summaries = source.turnSummaries()
      const index = summaries ? summaries.findIndex(turn => turn.id === turnId)
        : source.turnWindow(0, source.turnCount()).findIndex(turn => turn.id === turnId)
      const turn = index < 0 ? undefined : source.turnWindow(index, 1)[0]
      const text = turn?.answer.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n').trim() || turn?.errorMessage || ''
      if (!turn || turn.replyEntryId !== entryId || (!turn.answer.length && !text)) throw new Error('Saved reply not found')
      return { preview: text.replace(/\s+/g, ' ').slice(0, 300), firstMessage: source.turnWindow(0, 1)[0]?.user?.text.slice(0, 200) ?? '' }
    })
    const info = await stat(file)
    if (ownedSession(event, sessionId) !== owner) throw new Error('Session was replaced')
    const result = await bookmarks.add({
      id: replyBookmarkId(sessionId, entryId), turnId, entryId,
      kind: isChatCwd(owner.cwd) ? 'chat' : 'project',
      session: { id: sessionId, path: file, cwd: owner.cwd, name: title, created: info.birthtime.toISOString(), modified: info.mtime.toISOString(), size: info.size, firstMessage: details.firstMessage },
      preview: details.preview, createdAt: Date.now()
    })
    changed()
    return result
  })
  ipcMain.handle('bookmarks:remove', async (event, id: string) => {
    assertUi(event)
    requireId(id)
    const result = await bookmarks.remove(id)
    changed()
    return result
  })
  ipcMain.handle('bookmarks:locate', async (event, id: string) => {
    assertUi(event)
    requireId(id)
    const item = (await bookmarks.list()).items.find(item => item.id === id)
    if (!item) throw new Error('Bookmark not found')
    const owner = ownedSession(event, item.session.id)
    const turnIndex = await withSource(item.session.id, source => {
      if (!source.entryById(item.entryId)) throw new Error('Bookmarked reply no longer exists')
      if (!source.branchIds().includes(item.entryId)) return null
      const summaries = source.turnSummaries()
      const turns = summaries ?? source.turnWindow(0, source.turnCount())
      const index = turns.findIndex(turn => turn.id === item.turnId)
      if (index < 0) throw new Error('Bookmarked turn not found')
      return source.turnWindow(index, 1)[0]?.replyEntryId === item.entryId ? index : null
    })
    if (ownedSession(event, item.session.id) !== owner) throw new Error('Session was replaced')
    return { turnIndex }
  })
}
