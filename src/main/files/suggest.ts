import { isNotARepoError } from '../git/exec'
import { runGit } from '../git/run'
import { baseName } from '../../shared/paths'
import { readDirectory } from './tree'
import type { FileSuggestion } from '../../shared/api'

/**
 * The `@` completion source: one `git ls-files` per worktree, rescanned at most every few seconds
 * while the menu is open, scored the way Pi scores its own fuzzy rows. Directories are derived from
 * the files' ancestors rather than read off disk, so a huge untracked directory costs nothing — and a
 * query with a slash in it only keeps the entries below that base, which is what lets `@src/` descend.
 */
const SUGGESTION_LIMIT = 20
const LIST_TTL_MS = 10_000

const lists = new Map<string, { at: number; files: string[] }>()

async function listFiles(root: string): Promise<string[] | null> {
  const cached = lists.get(root)
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.files
  try {
    // Locale C: isNotARepoError reads the English stderr, which a translated git would not print.
    const files = (await runGit(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { locale: 'C' }))
      .split('\0')
      .filter((line) => line.length > 0)
    lists.set(root, { at: Date.now(), files })
    return files
  } catch (error) {
    // Only "not a repository" degrades to the top level; anything else (timeout, output cap) is
    // real and surfaces through the handler like every other file error.
    if (!isNotARepoError(error)) throw error
    lists.delete(root)
    return null
  }
}

function subsequence(haystack: string, needle: string): boolean {
  let next = 0
  for (const char of haystack) {
    if (char === needle[next]) {
      next += 1
      if (next === needle.length) return true
    }
  }
  return needle.length === 0
}

function scoreEntry(path: string, isDirectory: boolean, query: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const name = baseName(path).toLowerCase()
  const full = path.toLowerCase()
  let score = 0
  if (name === q) score = 100
  else if (name.startsWith(q)) score = 80
  else if (name.includes(q)) score = 50
  else if (full.includes(q)) score = 30
  else if (subsequence(name, q)) score = 20
  else if (subsequence(full, q)) score = 10
  if (score > 0 && isDirectory) score += 10
  return score
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length
}

/** Outside a repo there is no file list to score, so `@` lists one level by prefix — descending as
 * the query gains a base, the way the scored path does. */
async function suggestTopLevel(root: string, query: string): Promise<FileSuggestion[]> {
  const slash = query.lastIndexOf('/')
  const base = slash === -1 ? '' : query.slice(0, slash + 1)
  const q = (slash === -1 ? query : query.slice(slash + 1)).toLowerCase()
  // The base is typed, not chosen: it may name nothing (yet) or escape the worktree, which is an
  // empty list the way a non-matching base is in a repo — not an error worth rejecting per keystroke.
  const listing = await readDirectory(root, base).catch(() => null)
  if (!listing) return []
  return listing.entries
    .filter((entry) => !entry.ignored)
    .filter((entry) => entry.name.toLowerCase().startsWith(q))
    .sort((a, b) =>
      (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) ||
      a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })
    )
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => ({
      path: entry.kind === 'directory' ? `${entry.path}/` : entry.path,
      isDirectory: entry.kind === 'directory'
    }))
}

/** The file list ranked for one query: pure, so the order is unit-testable without git. */
export function rankCandidates(files: string[], query: string): FileSuggestion[] {
  const normalized = query.replace(/\\/g, '/')
  const candidates = new Map<string, boolean>()
  for (const file of files) {
    candidates.set(file, false)
    let slash = file.indexOf('/')
    while (slash !== -1) {
      candidates.set(file.slice(0, slash + 1), true)
      slash = file.indexOf('/', slash + 1)
    }
  }

  const slash = normalized.lastIndexOf('/')
  const base = slash === -1 ? '' : normalized.slice(0, slash + 1)
  const rest = slash === -1 ? normalized : normalized.slice(slash + 1)

  return [...candidates]
    .filter(([path]) => (base ? path.startsWith(base) && path !== base : true))
    .map(([path, isDirectory]) => ({ path, isDirectory, score: scoreEntry(path, isDirectory, rest) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      depth(a.path) - depth(b.path) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path)
    )
    .slice(0, SUGGESTION_LIMIT)
    .map(({ path, isDirectory }) => ({ path, isDirectory }))
}

export async function suggestFiles(root: string, query: string): Promise<FileSuggestion[]> {
  const files = await listFiles(root)
  if (!files || files.length === 0) return suggestTopLevel(root, query.replace(/\\/g, '/'))
  return rankCandidates(files, query)
}
