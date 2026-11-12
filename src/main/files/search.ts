/** Bounded breadth-first filename filtering; links are listed but never traversed. */
import type { FileSearchResult } from '../../shared/api'
import { readDirectory } from './tree'

export async function searchFiles(cwd: string, query: string, hideIgnored: boolean, signal?: AbortSignal): Promise<FileSearchResult> {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return { entries: [], truncated: false }
  const directories = ['']
  const entries: FileSearchResult['entries'] = []
  let visited = 0
  for (let index = 0; index < directories.length; index++) {
    signal?.throwIfAborted()
    if (index >= 500 || visited >= 10000) return { entries, truncated: true }
    const listing = await readDirectory(cwd, directories[index]!, { maxEntries: 10000 - visited, signal })
    visited += listing.scanned
    signal?.throwIfAborted()
    for (const entry of listing.entries) {
      if (hideIgnored && entry.ignored) continue
      if (entry.path.toLocaleLowerCase().includes(needle)) {
        if (entries.length >= 200) return { entries, truncated: true }
        entries.push(entry)
      }
      if (entry.kind === 'directory') directories.push(entry.path)
    }
    if (listing.truncated) return { entries, truncated: true }
  }
  return { entries, truncated: false }
}
