import { ipcMain } from 'electron'
import type { DiffScope } from '../../shared/api'
import { readUntrackedFile, readWorktreeDiff, readWorktreePatch } from '../git/diff'
import { unwatchWorktree, watchWorktree } from '../git/watch'

/** The review panel and the changes tab are the only clients: they read changes and hold the watch. */
export function registerDiffIpc(): void {
  ipcMain.handle('diff:read-worktree', async (_event, cwd: string) => readWorktreeDiff(cwd))
  ipcMain.handle('diff:read-patch', async (_event, cwd: string, scope: DiffScope) =>
    readWorktreePatch(cwd, scope)
  )
  ipcMain.handle('diff:read-untracked', async (_event, cwd: string, path: string) =>
    readUntrackedFile(cwd, path)
  )
  ipcMain.handle('diff:watch', async (_event, cwd: string) => watchWorktree(cwd))
  ipcMain.handle('diff:unwatch', async (_event, cwd: string, leaseId: string) => {
    unwatchWorktree(cwd, leaseId)
  })
}
