/* Shared on-disk transaction boundary for the main bundle and independent jiti runtimes. */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function personaDir(): string {
  const root = process.env.PIG_DIR
  if (!root) throw new Error('PIG_DIR is required for persona storage')
  return join(root, 'persona')
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export async function readOptional(path: string): Promise<string | null> {
  try { return await fs.readFile(path, 'utf8') } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function atomicWrite(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, join(dir, name))
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

interface Owner { pid: number; token: string; createdAt: number }

async function readOwner(file: string): Promise<Owner | null> {
  const raw = await readOptional(file)
  if (raw === null) return null
  const value = JSON.parse(raw) as Owner
  if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value.token !== 'string' || !value.token || !Number.isFinite(value.createdAt)) {
    throw new Error('Invalid persona lock owner')
  }
  return value
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

const STALE_MS = 30_000

async function isStale(path: string): Promise<boolean> {
  try { return Date.now() - (await fs.stat(path)).mtimeMs > STALE_MS } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** A lock whose owner died, or that never got (or already lost) owner.json because its holder crashed. */
async function isAbandoned(lock: string, ownerFile: string): Promise<boolean> {
  const owner = await readOwner(ownerFile)
  return owner ? !isAlive(owner.pid) : isStale(lock)
}

export async function withPersonaLock<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = personaDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
  const lock = join(dir, 'mood-state.lock')
  const ownerFile = join(lock, 'owner.json')
  const owner: Owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  const started = Date.now()
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 })
      try {
        await atomicWrite(lock, 'owner.json', JSON.stringify(owner))
      } catch (error) {
        await fs.rm(lock, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isAbandoned(lock, ownerFile)) {
        // Reclaimers serialize separately and re-read ownership; a delayed reclaimer cannot delete a new live lock.
        // A recovery directory left by a crashed reclaimer is itself reclaimed once stale.
        const recovery = `${lock}.recovery`
        let acquired = false
        try {
          try { await fs.mkdir(recovery, { mode: 0o700 }); acquired = true } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            if (await isStale(recovery)) await fs.rm(recovery, { recursive: true, force: true })
          }
          if (acquired && await isAbandoned(lock, ownerFile)) await fs.rm(lock, { recursive: true, force: true })
        } finally {
          if (acquired) await fs.rm(recovery, { recursive: true })
        }
      }
      if (Date.now() - started > 3000) throw new Error('Timed out acquiring persona mood-state lock')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const release = async (): Promise<void> => {
    const current = await readOwner(ownerFile)
    if (current?.token !== owner.token) throw new Error('Persona lock ownership changed')
    await fs.rm(lock, { recursive: true })
  }
  let result: T
  try {
    result = await action(dir)
  } catch (error) {
    // Keep the operation's failure visible even when releasing the lock also fails.
    await release().catch((releaseError: unknown) => {
      throw new AggregateError([error, releaseError], 'Persona operation failed and its lock could not be released')
    })
    throw error
  }
  await release()
  return result
}
