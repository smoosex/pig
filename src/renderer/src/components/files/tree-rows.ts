/**
 * What the file column shows, derived from the levels the store has loaded: a directory that is open
 * contributes the rows below itself, in the order git and the filesystem gave them, so the tree is a
 * flat list of rows with a depth rather than components nested one per level — which is what lets every
 * row keep the full width of the column for its hover background.
 */
import type { FileTreeEntry } from '../../ipc/api'
import type { DirectoryState } from '../../stores/files'

export interface TreeRow {
  entry: FileTreeEntry
  depth: number
}

export function treeRows(
  trees: Record<string, DirectoryState>,
  expanded: Record<string, boolean>,
  hideIgnored: boolean
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (path: string, depth: number) => {
    for (const entry of trees[path]?.entries ?? []) {
      if (hideIgnored && entry.ignored) continue
      rows.push({ entry, depth })
      if (entry.kind === 'directory' && expanded[entry.path]) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}
