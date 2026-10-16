/** Startup-only orphan sweep. Unknown parent paths and filesystem errors preserve data. */
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pigPath } from '../pig-dir'

export async function pruneOrphanSubagents(
  root: string = pigPath('subagents'),
  inUse: (parentSessionId: string) => boolean = () => false
): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || inUse(entry.name)) continue
    const directory = join(root, entry.name)
    try {
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as {
        subagents?: { parentSessionFile?: unknown }[]
      }
      if (!Array.isArray(index.subagents) || !index.subagents.length) continue
      const paths = index.subagents.map((item) => item?.parentSessionFile)
      // Mixed old/new indexes stay intact: every record must identify its parent before deleting.
      if (!paths.every((path): path is string => typeof path === 'string' && isAbsolute(path))) continue
      let orphan = true
      for (const path of new Set(paths)) {
        try {
          await stat(path)
          orphan = false
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (orphan && !inUse(entry.name)) await rm(directory, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Could not check orphan subagents ${entry.name}:`, error)
    }
  }
}
