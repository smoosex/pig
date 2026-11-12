/** Restricted Markdown storage. Synchronous commit under a directory lease keeps CAS and rename
 * indivisible to other sessions; a crashed writer's lease is reclaimed only after its PID is gone. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { MemoryFile, MemoryReadResult } from '../../../../shared/long-term-memory'
import { fileMemoryPath } from '../paths'

export const MAX_MEMORY_BYTES = 64 * 1024
export const MAX_INDEX_BYTES = 4096
export const MAX_INDEX_LINES = 60
const MAX_FILES = 1000
const MAX_DEPTH = 8
const MAX_ENTRIES = MAX_FILES * 2
export class MemoryFileError extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`) }
}
class MemoryLimitError extends Error {
  constructor(readonly code: 'MEMORY_DEPTH_LIMIT' | 'MEMORY_FILE_LIMIT' | 'MEMORY_SCAN_LIMIT', message: string) { super(message) }
}
export const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex')
export function memoryRoot(): string {
  return fileMemoryPath()
}
export function projectMemoryKey(project: string): string { return revisionOf(project) }

export function memoryLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function pathSegments(path: string): string[] {
  if (typeof path !== 'string' || !path || path.length > 500 || /[\\\\:<>|?*]/.test(path) || path.includes('%') || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid memory path')
  return path.split('/')
}
function safeParts(path: string): string[] {
  const parts = pathSegments(path)
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || !path.endsWith('.md')) throw new Error('Memory paths must be relative Markdown paths')
  return parts
}

/** Markdown links are relative to their source note; the returned path stays scope-root-relative. */
export function resolveMemoryLink(path: string, from = 'MEMORY.md'): string {
  const parts = safeParts(from).slice(0, -1)
  for (const part of pathSegments(path)) {
    if (part === '.') continue
    if (part === '..') {
      if (!parts.length) throw Object.assign(new Error('Memory link escapes its scope'), { code: 'MEMORY_LINK_OUTSIDE_SCOPE' })
      parts.pop()
    } else {
      if (!part || part.startsWith('.')) throw new Error('Memory links must be relative, non-hidden paths')
      parts.push(part)
    }
  }
  const resolved = parts.join('/')
  safeParts(resolved)
  return resolved
}

export class MemoryFiles {
  constructor(readonly root: string, private readonly catalogRoot: string = root) {}
  private target(path: string, create = false): string {
    const parts = safeParts(path)
    // Validate every existing ancestor, including the store root, without following symlinks.
    const absolute = resolve(this.root)
    const directories = absolute.split(sep).filter(Boolean)
    let cursor = absolute.startsWith(sep) ? sep : directories.shift()! + sep
    for (const part of [...directories, ...parts.slice(0, -1)]) {
      cursor = join(cursor, part)
      try {
        const info = lstatSync(cursor)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Memory directories must not be symbolic links')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (create) mkdirSync(cursor, { mode: 0o700 })
      }
    }
    const target = join(absolute, ...parts)
    try {
      const info = lstatSync(target)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Memory must be an unlinked regular file')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return target
  }
  resolve(path: string): string { return this.target(path) }
  read(path: string): MemoryFile {
    try {
      const target = this.target(path)
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_MEMORY_BYTES) throw new Error('Invalid or oversized memory file')
        const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd))
        return { path, content, revision: revisionOf(content) }
      } finally { closeSync(fd) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (typeof code !== 'string') throw error
      throw new MemoryFileError(code, code === 'ENOENT' ? `Memory file not found: ${path}` : `Unable to read memory file: ${path}`)
    }
  }
  optional(path: string): MemoryFile | undefined {
    try { return this.read(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
  }
  list(): { path: string; bytes: number }[] { return this.scan().files }
  private scan(): { files: { path: string; bytes: number }[]; visited: number } {
    this.target('MEMORY.md')
    if (!existsSync(this.root)) return { files: [], visited: 0 }
    const files: { path: string; bytes: number }[] = []
    let visited = 0
    const walk = (directory: string, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new MemoryLimitError('MEMORY_DEPTH_LIMIT', 'Memory directory depth exceeded')
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith('.')) continue
        if (++visited > MAX_ENTRIES) throw new MemoryLimitError('MEMORY_SCAN_LIMIT', 'Memory directory scan limit exceeded')
        const path = prefix + item.name
        if (item.isSymbolicLink()) throw new Error('Memory symbolic links are not allowed')
        if (item.isDirectory()) walk(join(directory, item.name), path + '/', depth + 1)
        else if (item.isFile() && item.name.endsWith('.md')) {
          const info = lstatSync(this.target(path))
          if (info.size > MAX_MEMORY_BYTES) throw new Error('Oversized memory file')
          files.push({ path, bytes: info.size })
          if (files.length > MAX_FILES) throw new MemoryLimitError('MEMORY_FILE_LIMIT', 'Memory file limit exceeded')
        }
      }
    }
    walk(this.root, '', 0)
    return { files, visited }
  }
  /** Call under the catalog lease before a batch commit. Retained empty directories still count. */
  checkPublication(nextPaths: readonly string[], inventory?: { files: { path: string }[]; visited: number; retainedFiles?: number }): void {
    const { files, visited } = inventory ?? this.scan()
    const existing = new Set(files.map(file => file.path))
    const next = new Set(nextPaths)
    if (next.size + (inventory?.retainedFiles ?? 0) > MAX_FILES) throw new MemoryLimitError('MEMORY_FILE_LIMIT', 'Memory file limit exceeded')
    const addedDirectories = new Set<string>()
    for (const path of next) {
      const parts = safeParts(path)
      if (parts.length - 1 > MAX_DEPTH) throw new MemoryLimitError('MEMORY_DEPTH_LIMIT', 'Memory directory depth exceeded')
      this.target(path)
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join('/')
        try { lstatSync(join(this.root, directory)) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          addedDirectories.add(directory)
        }
      }
    }
    const added = [...next].filter(path => !existing.has(path)).length
    const removed = [...existing].filter(path => !next.has(path)).length
    if (visited + addedDirectories.size + added - removed > MAX_ENTRIES) throw new MemoryLimitError('MEMORY_SCAN_LIMIT', 'Memory directory scan limit exceeded')
  }
  private checkCapacity(target: string, creating: boolean): void {
    const catalog = new MemoryFiles(this.catalogRoot)
    const path = relative(resolve(this.catalogRoot), target).split(sep).join('/')
    const parts = safeParts(path)
    if (parts.length - 1 > MAX_DEPTH) throw new MemoryLimitError('MEMORY_DEPTH_LIMIT', 'Memory directory depth exceeded')
    catalog.target(path)
    const { files, visited } = catalog.scan()
    if (creating && files.length >= MAX_FILES) throw new MemoryLimitError('MEMORY_FILE_LIMIT', 'Memory file limit exceeded')
    let added = creating ? 1 : 0
    let directory = this.catalogRoot
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part)
      try { lstatSync(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        added++
      }
    }
    if (visited + added > MAX_ENTRIES) throw new MemoryLimitError('MEMORY_SCAN_LIMIT', 'Memory directory scan limit exceeded')
  }
  view(path?: string, query?: string, offset = 0, limit = 100): MemoryReadResult {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid memory page')
    if (query !== undefined) {
      if (!query.trim() || query.length > 200) throw new Error('Invalid memory search')
      const matches: NonNullable<MemoryReadResult['matches']> = []
      const needle = query.toLocaleLowerCase()
      let seen = 0
      let bytes = 0
      for (const item of this.list()) {
        const lines = this.read(item.path).content.split('\n')
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]
          if (!line.toLocaleLowerCase().includes(needle)) continue
          if (seen++ < offset) continue
          if (matches.length === limit) return { matches, nextOffset: offset + matches.length }
          const match = { path: item.path, line: index + 1, text: line.slice(0, 300) }
          const size = Buffer.byteLength(JSON.stringify(match))
          if (bytes + size > 16000) return { matches, nextOffset: offset + matches.length }
          matches.push(match); bytes += size
        }
      }
      return { matches, nextOffset: null }
    }
    if (!path) {
      const files = this.list()
      const page = this.page(files, offset, limit)
      return { files: page.items, nextOffset: page.nextOffset }
    }
    const file = this.read(path)
    const lines = file.content.split('\n')
    const chosen: string[] = []
    let bytes = 0
    for (const line of lines.slice(offset, offset + limit)) {
      if (bytes + Buffer.byteLength(line) > 16000) break
      chosen.push(line); bytes += Buffer.byteLength(line) + 1
    }
    if (!chosen.length && offset < lines.length) throw new Error('Memory line too long; shorten it before reading')
    return { file: { ...file, content: chosen.join('\n') }, nextOffset: offset + chosen.length < lines.length ? offset + chosen.length : null }
  }
  private page<T>(items: T[], offset: number, limit: number): { items: T[]; nextOffset: number | null } {
    const result: T[] = []
    let bytes = 0
    for (const item of items.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(item))
      if (bytes + size > 16000) break
      result.push(item); bytes += size
    }
    return { items: result, nextOffset: offset + result.length < items.length ? offset + result.length : null }
  }
  private mutate<T>(path: string, action: (target: string) => T): T {
    const target = this.target(path)
    // Scoped stores share the catalog lease and quotas used by the settings browser.
    new MemoryFiles(this.catalogRoot).target('MEMORY.md', true)
    const lock = join(this.catalogRoot, '.writer')
    try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Serialize stale recovery itself: two reclaimers must not remove a newly acquired lease.
      const recovery = join(this.catalogRoot, '.writer-recovery')
      try { mkdirSync(recovery, { mode: 0o700 }) } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Memory writer recovery is busy; do not remove another writer lease')
        throw failure
      }
      try {
        if (lstatSync(lock).isSymbolicLink()) throw new Error('Invalid memory writer lease')
        const pid = join(lock, 'pid')
        const fd = openSync(pid, constants.O_RDONLY | constants.O_NOFOLLOW)
        let owner: number
        try {
          const info = fstatSync(fd)
          if (!info.isFile() || info.nlink !== 1 || info.size > 32) throw new Error('Invalid memory writer lease')
          owner = Number(readFileSync(fd, 'utf8'))
        } finally { closeSync(fd) }
        if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Invalid memory writer lease')
        try { process.kill(owner, 0); throw new Error('Memory writer is busy; read again before retrying') }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure }
        rmSync(lock, { recursive: true })
        // Another normal writer may win this mkdir; in that case leave its lease alone.
        mkdirSync(lock, { mode: 0o700 })
      } finally { rmSync(recovery, { recursive: true }) }
    }
    try {
      writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' })
      return action(target)
    } finally { rmSync(lock, { recursive: true }) }
  }
  /** Batch publishers share the exact lease used by ordinary note mutations. Keep the callback synchronous. */
  withCatalogLease<T>(action: () => T): T { return this.mutate('MEMORY.md', () => action()) }

  save(path: string, content: string, expectedRevision: string | null, check: () => void = () => {}): MemoryFile {
    if (typeof content !== 'string' || content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content || Buffer.byteLength(content) > MAX_MEMORY_BYTES) throw new Error('Memory file exceeds 64 KiB or contains invalid text')
    if (content.split('\n').some(line => Buffer.byteLength(line) > 15000)) throw new Error('Memory lines must stay within 15 KB for paged reading')
    if (path.split('/').at(-1) === 'MEMORY.md' && (Buffer.byteLength(content) > MAX_INDEX_BYTES || memoryLines(content).length > MAX_INDEX_LINES)) throw new Error('MEMORY.md must stay within 4 KiB and 60 lines; move details into linked notes')
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-|rk-|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|\b(?:password|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"'<>]{12,}/i.test(content)) throw new Error('Possible credentials must not be stored in memory')
    return this.mutate(path, target => {
      check()
      const current = this.optional(path)
      if (expectedRevision === null && current !== undefined) throw new MemoryFileError('MEMORY_ALREADY_EXISTS', `Memory file already exists: ${path}; read it and use memory_edit to update it`)
      if (expectedRevision !== null && current?.revision !== expectedRevision) throw new MemoryFileError('MEMORY_REVISION_CONFLICT', 'Memory revision conflict; read again and reconsider the change')
      this.checkCapacity(target, current === undefined)
      this.target(path, true)
      const temporary = join(dirname(target), `.${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
        check()
        renameSync(temporary, target)
      } finally { rmSync(temporary, { force: true }) }
      return { path, content, revision: revisionOf(content) }
    })
  }
  delete(path: string, expectedRevision: string, check: () => void = () => {}): void {
    this.mutate(path, target => {
      check()
      if (this.read(path).revision !== expectedRevision) throw new MemoryFileError('MEMORY_REVISION_CONFLICT', 'Memory revision conflict; read again before deleting')
      check(); unlinkSync(target)
      // Prune only empty ancestors inside this scope, while still holding the catalog writer lease.
      const root = resolve(this.root)
      let directory = dirname(target)
      try {
        while (directory !== root) {
          this.target(path)
          try { rmdirSync(directory) } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOTEMPTY' || code === 'EEXIST') break
            throw error
          }
          directory = dirname(directory)
        }
      } catch (error) {
        throw new MemoryFileError((error as NodeJS.ErrnoException).code ?? 'MEMORY_CLEANUP_FAILED', `Memory file was deleted, but empty-directory cleanup failed: ${path}`)
      }
    })
  }
}
