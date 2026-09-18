import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { DiffWatchError } from '../../shared/api'
import { pigDir } from '../pig-dir'
import { createWorktreeWatchManager } from './watch-manager'
import { runGit } from './run'

const manager = createWorktreeWatchManager({
  watch,
  runGit,
  dataDir: pigDir,
  createLease: randomUUID,
  sendChanged: (cwd) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('diff:changed', cwd)
    }
  },
  sendError: (error: DiffWatchError) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('diff:watch-error', error)
    }
  }
})

/** Keeps one complete root/Git watch alive for every renderer lease on a worktree. */
export const watchWorktree = manager.watchWorktree

/** Releases only the lease that acquired the shared worktree watch. */
export const unwatchWorktree = manager.unwatchWorktree
