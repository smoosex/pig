/**
 * What the file column shows, derived from the levels the store has loaded: a directory that is open
 * contributes the rows below itself, in the order git and the filesystem gave them, so the tree is a
 * flat list of rows with a depth rather than components nested one per level — which is what lets every
 * row keep the full width of the column for its hover background.
 *
 * A name being asked for is one of these rows too, rather than a dialog over them, and it stands where
 * the thing will be once it exists: a new folder leads the level, and a new file follows the folders,
 * because that is the order a listing is built in — folders first, then everything else. A rename needs
 * no placement at all: it is the row it names, standing exactly where it already was.
 */
import type { FileTreeEntry } from '../../ipc/api'
import type { DirectoryState, TreeDraft } from '../../stores/files'

export interface TreeRow {
  entry: FileTreeEntry
  depth: number
  /** What is being named at this row, when this row is a field rather than a row on disk. */
  draft?: TreeDraft['kind']
}

/**
 * The row a field for a new entry stands on: it has a depth and an icon but no name yet. Nothing reads
 * its path — the field is the only thing that knows what is being asked for — but the icon is what says
 * whether a file or a folder is about to be made, so it follows the kind being made.
 */
function newEntry(kind: 'file' | 'folder'): FileTreeEntry {
  return { name: '', path: '', kind: kind === 'folder' ? 'directory' : 'file', ignored: false }
}

/** Where a level's first file sits: after every folder, which is the order a listing arrives in. */
function firstFile(entries: FileTreeEntry[]): number {
  const index = entries.findIndex((entry) => entry.kind !== 'directory')
  return index === -1 ? entries.length : index
}

export function treeRows(
  trees: Record<string, DirectoryState>,
  expanded: Record<string, boolean>,
  hideIgnored: boolean,
  draft: TreeDraft | null
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (path: string, depth: number) => {
    // What the reader can see is what the field has to be placed among, so a row the ignore toggle is
    // hiding is not one the field has to sit behind.
    const entries = (trees[path]?.entries ?? []).filter((entry) => !(hideIgnored && entry.ignored))
    const naming = draft?.kind !== 'rename' && draft?.directory === path ? draft.kind : null
    const at = naming === 'folder' ? 0 : naming === 'file' ? firstFile(entries) : -1
    let placed = naming === null

    const place = () => {
      if (placed) return
      placed = true
      rows.push({ entry: newEntry(naming!), depth, draft: naming! })
    }

    entries.forEach((entry, index) => {
      if (index === at) place()
      const renaming = draft?.kind === 'rename' && draft.path === entry.path
      rows.push({ entry, depth, draft: renaming ? 'rename' : undefined })
      if (entry.kind === 'directory' && expanded[entry.path]) walk(entry.path, depth + 1)
    })
    // A level the loop could not place into: it is empty, or holds only folders, which were walked past.
    place()
  }
  walk('', 0)
  return rows
}
