/**
 * The review column's tree view: the changed paths folded back into the directories they live in. Like
 * the file column, the tree is handed to React as a flat list of rows with a depth, so every row keeps
 * the column's full width for its hover background.
 *
 * A directory whose only child is another directory is drawn as one row (`src/main/pi`), the way a
 * changed file deep in the repo would otherwise cost a row per level. Within a level folders come
 * first, then files, each by name — the order the file column lists a directory in.
 */
import type { DiffFileEntry } from '../../ipc/api'
import { compareFileNames } from '../../../../shared/file-order'
import { splitPath } from './file-entry'

export type ChangeTreeRow =
  | { kind: 'directory'; path: string; name: string; depth: number; open: boolean; entries: DiffFileEntry[] }
  | { kind: 'file'; entry: DiffFileEntry; depth: number }

interface Directory {
  directories: Map<string, Directory>
  files: DiffFileEntry[]
  /** Every file below this directory, for the counts on its row. */
  entries: DiffFileEntry[]
}

function directory(): Directory {
  return { directories: new Map(), files: [], entries: [] }
}

/** `collapsed` is asked with the directory's repo-relative path; a directory is open unless it says so. */
export function changeTreeRows(entries: DiffFileEntry[], collapsed: (path: string) => boolean): ChangeTreeRow[] {
  const root = directory()
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let child = node.directories.get(part)
      if (!child) node.directories.set(part, (child = directory()))
      child.entries.push(entry)
      node = child
    }
    node.files.push(entry)
  }

  const rows: ChangeTreeRow[] = []
  const walk = (node: Directory, prefix: string, depth: number) => {
    for (const name of [...node.directories.keys()].sort(compareFileNames)) {
      let child = node.directories.get(name)!
      let label = name
      while (child.files.length === 0 && child.directories.size === 1) {
        const [only, next] = [...child.directories][0]
        label = `${label}/${only}`
        child = next
      }
      const path = prefix + label
      const open = !collapsed(path)
      rows.push({ kind: 'directory', path, name: label, depth, open, entries: child.entries })
      if (open) walk(child, `${path}/`, depth + 1)
    }
    const files = [...node.files].sort((a, b) => compareFileNames(splitPath(a.path).name, splitPath(b.path).name))
    for (const entry of files) rows.push({ kind: 'file', entry, depth })
  }
  walk(root, '', 0)
  return rows
}
