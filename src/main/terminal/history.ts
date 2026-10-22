/** Names the restart records the PTY host writes and removes the ones no saved tab will ask for. */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pigPath } from '../pig-dir'
import { terminalHistoryFile } from './history-file'

const directory = () => pigPath('terminals')

export function terminalHistoryPath(id: string): string {
  return join(directory(), terminalHistoryFile(id))
}

/**
 * Runs before any window exists. A record outlives its tab when the tab closed before its shell ever
 * started, or when the app stopped before the deletion reached the disk.
 */
export async function pruneTerminalHistories(openTerminalIds: string[]): Promise<void> {
  let names: string[]
  try {
    names = await readdir(directory())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const kept = new Set(openTerminalIds.map(terminalHistoryFile))
  await Promise.all(names.filter((name) => !kept.has(name)).map((name) => rm(join(directory(), name), { force: true })))
}
