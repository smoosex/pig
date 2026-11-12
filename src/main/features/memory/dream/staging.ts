/** Copy-on-run memory workspace. Publication holds the normal catalog lease, checks the read
 * snapshot, prepares every replacement, and restores originals on synchronous commit failures. */
import { mkdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryFile } from '../../../../shared/long-term-memory'
import { MemoryFiles, memoryRoot, resolveMemoryLink } from '../long-term/files'

export class DreamStage {
  readonly store: MemoryFiles
  private readonly before = new Map<string, MemoryFile>()
  constructor(readonly directory: string, private readonly live = new MemoryFiles(memoryRoot())) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.store = new MemoryFiles(join(directory, 'staged'))
    live.withCatalogLease(() => {
      for (const { path } of live.list()) {
        const file = live.read(path)
        this.before.set(path, file)
        const target = this.store.resolve(path)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        writeFileSync(target, file.content, { mode: 0o600, flag: 'wx' })
      }
    })
  }
  publish(writable: Set<string>, check: () => void): string[] {
    const after = new Map(this.store.list().map(({ path }) => [path, this.store.read(path)]))
    const paths = [...new Set([...this.before.keys(), ...after.keys()])]
      .filter(path => this.before.get(path)?.revision !== after.get(path)?.revision)
    for (const path of paths) {
      const scope = path.startsWith('global/') ? 'global' : path.split('/').slice(0, 2).join('/')
      if (!writable.has(scope)) throw new Error('DREAM_SCOPE: Memory change is outside the writable scope')
    }
    const changed = new Set(paths)
    const deleted = new Set(paths.filter(path => !after.has(path)))
    // Validate new/changed links and incoming references to deleted notes, not unrelated legacy gaps.
    for (const [path, file] of after) {
      if (!changed.has(path) && !deleted.size) continue
      const parts = path.split('/')
      const prefix = parts[0] === 'global' ? 'global' : parts.slice(0, 2).join('/')
      const local = path.slice(prefix.length + 1)
      for (const match of file.content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const link = match[1]
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link)) continue
        const linkPath = link.split('#')[0]
        // Unchanged notes matter only when a link can point to a note deleted by this batch.
        const candidate = `${prefix}/${posix.normalize(`${posix.dirname(local)}/${linkPath}`)}`
        if (!changed.has(path) && (linkPath.startsWith('/') || !deleted.has(candidate))) continue
        const target = `${prefix}/${resolveMemoryLink(linkPath, local)}`
        if (!after.has(target)) throw new Error('DREAM_LINK: Affected memory link has no target')
      }
    }
    return this.live.withCatalogLease(() => {
      check()
      const current = this.live.list()
      if (current.length !== this.before.size || current.some(({ path }) => this.live.read(path).revision !== this.before.get(path)?.revision)) {
        throw new Error('DREAM_CONFLICT: Memories changed during Dream; nothing was published')
      }
      this.live.checkPublication([...after.keys()])
      const temporary = new Map<string, string>()
      const createdDirectories = new Set<string>()
      const applied: string[] = []
      try {
        for (const path of paths) {
          const original = this.before.get(path)
          if (original) {
            const backup = join(this.directory, 'before', path)
            mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
            writeFileSync(backup, original.content, { mode: 0o600, flag: 'wx' })
          }
          const file = after.get(path)
          if (!file) continue
          const target = this.live.resolve(path)
          const firstCreated = mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
          if (firstCreated) {
            for (let directory = dirname(target); ; directory = dirname(directory)) {
              createdDirectories.add(directory)
              if (directory === firstCreated) break
            }
          }
          const temp = join(dirname(target), `.${randomUUID()}.tmp`)
          temporary.set(path, temp)
          writeFileSync(temp, file.content, { mode: 0o600, flag: 'wx' })
        }
        writeFileSync(join(this.directory, 'changes.json'), JSON.stringify(paths.map(path => ({ path, before: this.before.get(path)?.revision ?? null, after: after.get(path)?.revision ?? null }))), { mode: 0o600, flag: 'wx' })
        check()
        for (const path of paths) {
          const target = this.live.resolve(path)
          if (after.has(path)) renameSync(temporary.get(path)!, target)
          else unlinkSync(target)
          applied.push(path)
        }
      } catch (error) {
        const failures: unknown[] = [error]
        for (const path of applied.reverse()) {
          try {
            const original = this.before.get(path)
            if (original) {
              const target = this.live.resolve(path)
              const temp = join(dirname(target), `.${randomUUID()}.tmp`)
              try {
                writeFileSync(temp, original.content, { mode: 0o600, flag: 'wx' })
                renameSync(temp, target)
              } finally { rmSync(temp, { force: true }) }
            } else rmSync(this.live.resolve(path), { force: true })
          } catch (failure) { failures.push(failure) }
        }
        for (const temp of temporary.values()) {
          try { rmSync(temp, { force: true }) } catch (failure) { failures.push(failure) }
        }
        for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
          try { rmdirSync(directory) } catch (failure) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((failure as NodeJS.ErrnoException).code ?? '')) failures.push(failure)
          }
        }
        if (failures.length > 1) throw new AggregateError(failures, 'DREAM_RECOVERY: Publication failed; backups are preserved for recovery')
        throw error
      } finally {
        for (const temp of temporary.values()) rmSync(temp, { force: true })
      }
      // Only empty note directories are reclaimed. Scope roots stay in place.
      for (const path of paths.filter(path => !after.has(path))) {
        const scope = path.startsWith('global/') ? 'global' : path.split('/').slice(0, 2).join('/')
        const root = join(this.live.root, scope)
        let directory = dirname(this.live.resolve(path))
        while (directory !== root) {
          try { rmdirSync(directory) } catch (error) {
            if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) break
            throw new Error('DREAM_CLEANUP: Memories were published but empty-directory cleanup failed')
          }
          directory = dirname(directory)
        }
      }
      return paths
    })
  }
}
