/** Resolves permission paths without executing helpers, including not-yet-created files. */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function realTarget(path: string, links = 0): string {
  if (links > 40) throw new Error('Too many symbolic links in permission path')
  let existing = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      const stat = lstatSync(existing)
      if (stat.isSymbolicLink()) {
        return realTarget(join(resolve(dirname(existing), readlinkSync(existing)), ...rest), links + 1)
      }
      return join(realpathSync.native(existing), ...rest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      rest.unshift(existing.slice(parent.length).replace(/^[/\\]/, ''))
      existing = parent
    }
  }
}
