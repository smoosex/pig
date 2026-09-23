import type { FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import type { DiffWatchError } from '../../shared/api'
import { isNotARepoError } from './exec'
import { gitWatchTargets, isGitLockEvent, isIgnoredWatchPath } from './watch-path'
import { t } from '../i18n'

interface Watched {
  watcher: FSWatcher
  gitWatchers: FSWatcher[]
  leases: Set<string>
  ready: Promise<void>
  readyDone: boolean
  closed: boolean
  closedError?: Error
  timer?: ReturnType<typeof setTimeout>
}

export interface WorktreeWatchManagerOptions {
  watch: (
    path: string,
    options: { recursive: true },
    listener: (event: string, filename: string | null) => void
  ) => FSWatcher
  runGit: (cwd: string, args: string[], options: { locale: 'C' }) => Promise<string>
  dataDir: () => string
  createLease: () => string
  sendChanged: (cwd: string) => void
  sendError: (error: DiffWatchError) => void
  debounceMs?: number
}

export function createWorktreeWatchManager(options: WorktreeWatchManagerOptions): {
  watchWorktree: (cwd: string) => Promise<string>
  unwatchWorktree: (cwd: string, leaseId: string) => void
} {
  const watched = new Map<string, Watched>()
  const debounceMs = options.debounceMs ?? 300

  const closeEntry = (cwd: string, entry: Watched): string[] => {
    if (entry.closed) return []
    entry.closed = true
    clearTimeout(entry.timer)
    entry.watcher.close()
    for (const watcher of entry.gitWatchers.splice(0)) watcher.close()
    const leases = [...entry.leases]
    entry.leases.clear()
    if (watched.get(cwd) === entry) watched.delete(cwd)
    return leases
  }

  const failEntry = (cwd: string, entry: Watched, error: Error): void => {
    if (entry.closedError) return
    entry.closedError = error
    const leases = closeEntry(cwd, entry)
    if (!entry.readyDone) return
    for (const leaseId of leases) options.sendError({ cwd, leaseId, message: error.message })
  }

  const notify = (cwd: string): void => {
    const entry = watched.get(cwd)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => options.sendChanged(cwd), debounceMs)
  }

  const assertCurrent = (cwd: string, entry: Watched): void => {
    if (watched.get(cwd) !== entry) throw entry.closedError ?? new Error(t('error.watchClosed'))
  }

  const watchGitDir = async (cwd: string, entry: Watched): Promise<void> => {
    let targets: ReturnType<typeof gitWatchTargets>
    try {
      const [gitDir, commonDir, index] = await Promise.all([
        options.runGit(cwd, ['rev-parse', '--absolute-git-dir'], { locale: 'C' }),
        options.runGit(cwd, ['rev-parse', '--git-common-dir'], { locale: 'C' }),
        options.runGit(cwd, ['rev-parse', '--git-path', 'index'], { locale: 'C' })
      ])
      targets = gitWatchTargets(cwd, {
        gitDir: gitDir.trim(),
        index: index.trim(),
        refsDir: resolve(cwd, commonDir.trim(), 'refs')
      })
    } catch (error) {
      if (isNotARepoError(error)) return
      throw error
    }

    for (const target of targets) {
      assertCurrent(cwd, entry)
      let watcher: FSWatcher
      try {
        watcher = options.watch(target.path, { recursive: true }, (_event, filename) => {
          if (target.filterLocks && filename && isGitLockEvent(filename)) return
          notify(cwd)
        })
      } catch (error) {
        throw asError(error)
      }
      watcher.on('error', (error) => failEntry(cwd, entry, asError(error)))
      if (watched.get(cwd) !== entry) {
        watcher.close()
        throw entry.closedError ?? new Error(t('error.watchClosed'))
      }
      entry.gitWatchers.push(watcher)
    }
    assertCurrent(cwd, entry)
  }

  const watchWorktree = async (cwd: string): Promise<string> => {
    const leaseId = options.createLease()
    const existing = watched.get(cwd)
    if (existing) {
      existing.leases.add(leaseId)
      await existing.ready
      if (watched.get(cwd) !== existing) throw existing.closedError ?? new Error(t('error.watchClosed'))
      return leaseId
    }

    let watcher: FSWatcher
    try {
      watcher = options.watch(cwd, { recursive: true }, (_event, filename) => {
        if (filename && isIgnoredWatchPath(cwd, filename, options.dataDir())) return
        notify(cwd)
      })
    } catch (error) {
      throw asError(error)
    }

    const entry: Watched = {
      watcher,
      gitWatchers: [],
      leases: new Set([leaseId]),
      ready: Promise.resolve(),
      readyDone: false,
      closed: false
    }
    watched.set(cwd, entry)
    watcher.on('error', (error) => failEntry(cwd, entry, asError(error)))
    entry.ready = watchGitDir(cwd, entry).catch((error) => {
      const failure = asError(error)
      entry.closedError = failure
      closeEntry(cwd, entry)
      throw failure
    })

    await entry.ready
    if (watched.get(cwd) !== entry) throw entry.closedError ?? new Error(t('error.watchClosed'))
    entry.readyDone = true
    return leaseId
  }

  const unwatchWorktree = (cwd: string, leaseId: string): void => {
    const entry = watched.get(cwd)
    if (!entry?.leases.delete(leaseId)) return
    if (entry.leases.size === 0) closeEntry(cwd, entry)
  }

  return { watchWorktree, unwatchWorktree }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
