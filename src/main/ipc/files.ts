import { ipcMain, shell } from 'electron'
import type { FileStamp } from '../../shared/api'
import { externalPath, openablePath, readFile, writeFile } from '../files/file'
import { readDirectory } from '../files/tree'
import { requireWorktree } from '../worktree-access'

/**
 * The file tree and the file tabs: one directory level, one file's bytes, and one draft write. Every
 * handler resolves the worktree first, because a cwd the renderer sent is a request rather than a fact.
 */
export function registerFilesIpc(): void {
  ipcMain.handle('files:read-directory', async (_event, cwd: string, path: string) =>
    readDirectory(await requireWorktree(cwd), path)
  )
  ipcMain.handle('files:read', async (_event, cwd: string, path: string) =>
    readFile(await requireWorktree(cwd), path)
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
}
