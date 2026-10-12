import { clipboard, ipcMain, shell } from 'electron'
import type { FileStamp } from '../../shared/api'
import { externalPath, openablePath, readFile, writeFile } from '../files/file'
import { absolutePath, createEntry, renameEntry } from '../files/mutations'
import { suggestFiles } from '../files/suggest'
import { readDirectory } from '../files/tree'
import { openedWorktree, requireWorktree } from '../worktree-access'

/**
 * The file tree and the file tabs: one directory level, one file's bytes, and one draft write. Every
 * handler resolves the worktree first, because a cwd the renderer sent is a request rather than a fact.
 * The `@` suggest handler answers `[]` for a cwd with no workspace — a chat composer has none — but
 * its own failures propagate like every other handler: the composer already clears a failed fetch.
 */
export function registerFilesIpc(): void {
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
