import { clipboard, ipcMain, shell } from 'electron'
import type { FileStamp } from '../../shared/api'
import { externalPath, fileMentionInfo, openablePath, readFile, writeFile } from '../files/file'
import { absolutePath, createEntry, renameEntry } from '../files/mutations'
import { suggestFiles } from '../files/suggest'
import { readDirectory } from '../files/tree'
import { searchFiles } from '../files/search'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { openedWorktree, requireWorktree } from '../worktree-access'

/**
 * The file tree and the file tabs: one directory level, one file's bytes, and one draft write. Every
 * handler resolves the worktree first, because a cwd the renderer sent is a request rather than a fact.
 * The `@` suggest handler answers `[]` for a cwd with no workspace — a chat composer has none — but
 * its own failures propagate like every other handler: the composer already clears a failed fetch.
 */
export function registerFilesIpc(): void {
  const searches = new WeakMap<Electron.WebContents, AbortController>()
  ipcMain.handle('files:cancel-search', event => {
    assertBrowserSender(event, windowForEvent(event))
    searches.get(event.sender)?.abort()
    searches.delete(event.sender)
  })
  ipcMain.handle('files:search', async (event, cwd: string, query: string, hideIgnored: boolean) => {
    assertBrowserSender(event, windowForEvent(event))
    if (typeof query !== 'string' || query.length > 500 || typeof hideIgnored !== 'boolean') throw new Error('Invalid file search')
    searches.get(event.sender)?.abort()
    const controller = new AbortController()
    searches.set(event.sender, controller)
    const abort = () => controller.abort()
    const navigating = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) abort() }
    event.sender.once('destroyed', abort)
    event.sender.once('render-process-gone', abort)
    event.sender.on('did-start-navigation', navigating)
    try {
      const root = await requireWorktree(cwd)
      controller.signal.throwIfAborted()
      const result = await searchFiles(root, query, hideIgnored, controller.signal)
      assertBrowserSender(event, windowForEvent(event))
      return result
    } finally {
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('render-process-gone', abort)
      event.sender.removeListener('did-start-navigation', navigating)
      if (searches.get(event.sender) === controller) searches.delete(event.sender)
    }
  })
  ipcMain.handle('files:read-directory', async (_event, cwd: string, path: string) =>
    readDirectory(await requireWorktree(cwd), path)
  )
  ipcMain.handle('files:read', async (_event, cwd: string, path: string) =>
    readFile(await requireWorktree(cwd), path)
  )
  ipcMain.handle('files:suggest', async (_event, cwd: string, query: string) => {
    const root = await openedWorktree(cwd)
    if (!root) return []
    return suggestFiles(root, query)
  })
  ipcMain.handle('files:mention-info', async (_event, cwd: string, path: string) =>
    fileMentionInfo(await requireWorktree(cwd), path)
  )
  ipcMain.handle(
    'files:write',
    async (
      _event,
      cwd: string,
      path: string,
      contents: string,
      options: { expected?: FileStamp; overwrite?: boolean } | undefined
    ) => writeFile(await requireWorktree(cwd), path, contents, options ?? {})
  )
  ipcMain.handle('files:open-externally', async (_event, cwd: string, path: string) => {
    const failure = await shell.openPath(await openablePath(await requireWorktree(cwd), path))
    if (failure) throw new Error(failure)
  })
  ipcMain.handle('files:reveal-externally', async (_event, cwd: string, path: string) => {
    shell.showItemInFolder(await externalPath(await requireWorktree(cwd), path))
  })
  ipcMain.handle('files:create-file', async (_event, cwd: string, path: string) =>
    createEntry(await requireWorktree(cwd), path, 'file')
  )
  ipcMain.handle('files:create-directory', async (_event, cwd: string, path: string) =>
    createEntry(await requireWorktree(cwd), path, 'directory')
  )
  ipcMain.handle('files:rename', async (_event, cwd: string, path: string, name: string) =>
    renameEntry(await requireWorktree(cwd), path, name)
  )
  // The desktop's own trash, not an unlink: a reader who changes their mind gets the row back.
  ipcMain.handle('files:trash', async (_event, cwd: string, path: string) => {
    await shell.trashItem(await absolutePath(await requireWorktree(cwd), path))
  })
  // The desktop's own clipboard rather than the page's: the path is main's to resolve, and the reader
  // asked for it to paste somewhere else.
  ipcMain.handle('files:copy-path', async (_event, cwd: string, path: string) => {
    clipboard.writeText(await absolutePath(await requireWorktree(cwd), path))
  })
}
