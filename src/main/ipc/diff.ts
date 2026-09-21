import { ipcMain } from 'electron'
import type { DiffScope } from '../../shared/api'
import { readUntrackedFile, readWorktreeDiff, readWorktreePatch } from '../git/diff'
import { unwatchWorktree, watchWorktree } from '../git/watch'
import { requireWorktree } from '../worktree-access'

/**
 * The review panel and the changes tab are the only clients: they read changes and hold the watch. The
 * worktree is resolved before git is asked anything, so a cwd the renderer sent cannot point the reads
 * or the watcher at some other directory.
 */
export function registerDiffIpc(): void {
  ipcMain.handle('diff:read-worktree', async (_event, cwd: string) =>
    readWorktreeDiff(await requireWorktree(cwd))
  )
  ipcMain.handle('diff:read-patch', async (_event, cwd: string, scope: DiffScope) =>
    readWorktreePatch(await requireWorktree(cwd), scope)
  )
  ipcMain.handle('diff:read-untracked', async (_event, cwd: string, path: string) =>
    readUntrackedFile(await requireWorktree(cwd), path)
  )
  ipcMain.handle('diff:watch', async (_event, cwd: string) => watchWorktree(await requireWorktree(cwd)))
  ipcMain.handle('diff:unwatch', async (_event, cwd: string, leaseId: string) => {
    unwatchWorktree(await requireWorktree(cwd), leaseId)
  })
}
