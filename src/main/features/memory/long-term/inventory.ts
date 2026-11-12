/** Bounded, read-only diagnostics for externally modified memory trees. Bad entries never hide good ones. */
import { lstatSync, opendirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { MemoryFileListItem } from '../../../../shared/long-term-memory'
import { MemoryFiles, MAX_MEMORY_BYTES } from './files'

export const memoryScopeOf = (path: string): string | undefined =>
  /^(global|projects\/[a-f0-9]{64})\/.+\.md$/.exec(path)?.[1]

export function inspectMemoryDirectory(root: string): { files: MemoryFileListItem[]; visited: number; truncated: boolean } {
  const files: MemoryFileListItem[] = []
  const store = new MemoryFiles(root)
  let visited = 0, count = 0, truncated = false
  const issue = (path: string, code: string) => files.push({ path, bytes: 0, issue: code })
  // Match ordinary memory storage's refusal to traverse symbolic-link ancestors.
  for (let path = resolve(root); ; path = dirname(path)) {
    try { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid memory root') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('MEMORY_ROOT: Unable to inspect the memory directory safely') }
    if (dirname(path) === path) break
  }
  const walk = (directory: string, prefix: string, depth: number) => {
    let dir: ReturnType<typeof opendirSync>
    try { dir = opendirSync(directory) }
    catch (error) {
      if (!prefix && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (!prefix) throw new Error('MEMORY_ROOT: Unable to list the memory directory')
      issue(prefix.slice(0, -1), 'MEMORY_UNREADABLE'); return
    }
    try {
      for (let item = dir.readSync(); item; item = dir.readSync()) {
        if (item.name.startsWith('.')) continue
        if (++visited > 2000) { truncated = true; issue(prefix || '.', 'MEMORY_SCAN_LIMIT'); break }
        const path = prefix + item.name
        try {
          const info = lstatSync(join(directory, item.name))
          if (info.isSymbolicLink()) { issue(path, 'MEMORY_SYMLINK'); continue }
          if (info.isDirectory()) {
            if (depth >= 8) { truncated = true; issue(path, 'MEMORY_DEPTH_LIMIT') }
            else walk(join(directory, item.name), path + '/', depth + 1)
          } else if (info.isFile() && path.endsWith('.md')) {
            if (++count > 1000) { truncated = true; issue(path, 'MEMORY_FILE_LIMIT'); break }
            if (info.size > MAX_MEMORY_BYTES) { issue(path, 'MEMORY_OVERSIZED'); continue }
            store.read(path)
            files.push({ path, bytes: info.size, ...(!memoryScopeOf(path) ? { issue: 'MEMORY_MISPLACED', repairable: true } : {}) })
          }
        } catch { issue(path, 'MEMORY_UNREADABLE') }
        if (truncated && (visited > 2000 || count > 1000)) break
      }
    } finally { dir.closeSync() }
  }
  walk(root, '', 0)
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), visited, truncated }
}
