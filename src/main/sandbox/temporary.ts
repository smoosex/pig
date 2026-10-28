/** Private scratch space avoids granting all of /tmp, which may also contain Pig's protected data. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { within } from './policy'

let directory: string | undefined

export function sandboxTemporary(pig: string): string {
  if (directory && !within(pig, directory)) return directory
  clearSandboxTemporary()
  const parents = [tmpdir(), process.platform === 'darwin' ? '/private/tmp' : '/tmp', homedir()]
  for (const parent of parents) {
    const real = realpathSync.native(parent)
    if (within(pig, real)) continue
    directory = mkdtempSync(join(real, 'pig-sandbox-'))
    return directory
  }
  throw new Error('Pig data directory overlaps all sandbox temporary locations')
}

export function clearSandboxTemporary(): void {
  if (!directory) return
  rmSync(directory, { recursive: true, force: true })
  directory = undefined
}
