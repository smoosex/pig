/**
 * One level of the file tree: what a directory holds, with git's own answer about what is ignored.
 * Nothing here descends into a subdirectory — the tree asks for one level at a time as the reader opens
 * it, so a worktree with a huge `node_modules` only pays for what is on screen — and a link that leads
 * out of the worktree is refused rather than listed.
 */
import { readdir } from 'node:fs/promises'
import type { DirectoryListing, FileTreeEntry } from '../../shared/api'
import { GitExecError, isNotARepoError } from '../git/exec'
import { execGit } from '../git/exec'
import { resolveWorktreePath } from './paths'
import { t } from '../i18n'

/** Never listed: git's own directory is machinery, and no editor shows it. */
const HIDDEN = new Set(['.git'])

/** `git check-ignore` takes the paths as arguments, so they go over in batches well inside ARG_MAX. */
const IGNORE_BATCH = 256

export async function readDirectory(cwd: string, path: string): Promise<DirectoryListing> {
  const target = await resolveWorktreePath(cwd, path, 'directory')
  if (!target) throw new Error(t('error.directoryOutsideWorkspace'))
  const dirents = await readdir(target.absolute, { withFileTypes: true })

  const entries: FileTreeEntry[] = []
  for (const dirent of dirents) {
    if (HIDDEN.has(dirent.name)) continue
    const kind = dirent.isDirectory()
      ? 'directory'
      : dirent.isFile()
        ? 'file'
        : dirent.isSymbolicLink()
          ? 'link'
          : null
    // Sockets, fifos and devices are not something a reader can open or edit, so they are not rows.
    if (!kind) continue
    const entryPath = target.relative ? `${target.relative}/${dirent.name}` : dirent.name
    entries.push({ name: dirent.name, path: entryPath, kind, ignored: false })
  }

  const ignored = await ignoredPaths(
    target.absolute,
    // A directory is asked about with a trailing slash: `dist/` in a `.gitignore` matches the directory
    // and not a file of the same name, and git needs the slash to tell which one is being asked about.
    entries.map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name))
  )
  const folders = entries.filter((entry) => entry.kind === 'directory').sort(byName)
  const leaves = entries.filter((entry) => entry.kind !== 'directory').sort(byName)
  return {
    path: target.relative,
    entries: [...folders, ...leaves].map((entry) => ({ ...entry, ignored: ignored.has(entry.name) }))
  }
}

/** Directories first, then everything else, each by name — the order every file tree uses. */
function byName(left: FileTreeEntry, right: FileTreeEntry): number {
  return left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
}

/**
 * Which of these names, in this one directory, git ignores. `check-ignore` answers with the paths it
 * ignored and nothing else, so the set is what came back — and a name is only trusted to be in it when
 * the answer is spelled exactly as the question was, which leaves a name git would quote (a newline in
 * it) as a plain, undimmed row rather than one mislabelled from an escaped line.
 *
 * Git is asked from the directory being listed, about names in it, rather than from the worktree root
 * about the paths below it: a pathspec that walks through a link is refused outright by `check-ignore` —
 * even when the link leads back inside the worktree — and that refusal would cost the whole level its
 * ignore verdicts. A bare name cannot walk through anything.
 */
async function ignoredPaths(directory: string, names: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  for (let start = 0; start < names.length; start += IGNORE_BATCH) {
    const batch = names.slice(start, start + IGNORE_BATCH)
    let output: string
    try {
      // Not `runGit`: it asks for literal pathspecs, and `check-ignore` refuses that magic outright. The
      // names go over as themselves, and the answer is only trusted where it is spelled as the question
      // was, so a name that happened to look like a pattern cannot mark anything it did not match.
      output = await execGit(directory, ['check-ignore', '--', ...batch], {
        optionalLocks: false,
        quotePath: false,
        locale: 'C'
      })
    } catch (error) {
      // Exit 1 is "none of these are ignored" and a directory outside a repository is 128: the tree shows
      // every row undimmed, which is what having no ignore rules amounts to, and neither means the level
      // is unreadable.
      if (error instanceof GitExecError && (error.code === 1 || isNotARepoError(error))) continue
      throw error
    }
    for (const line of output.split('\n')) {
      const name = line.endsWith('/') ? line.slice(0, -1) : line
      if (name && batch.includes(line)) ignored.add(name)
    }
  }
  return ignored
}
