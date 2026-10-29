// Browse one directory at a time; filesystem paths are resolved before crossing the IPC boundary.
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, parse, relative, sep } from 'node:path'
import type { ProjectDirectoryListing, ProjectDirectorySearch } from '../shared/api'

const DIRECTORY_LIMIT = 500
const PLUGIN_FILE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json'])
const STAT_BATCH_SIZE = 32
const SEARCH_RESULT_LIMIT = 200
// Counts readdir and .git probes alike: the frontier level's probes are real work too.
const SEARCH_OPERATION_LIMIT = 40_000
const SEARCH_DEPTH_LIMIT = 8
// Dependency and build trees are never projects and would dominate the visit budget.
const SEARCH_SKIPPED = new Set(['node_modules', 'bower_components', 'vendor', 'target', 'dist', 'build', 'out'])

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM'
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const isPluginFileName = (name: string) => PLUGIN_FILE_EXTENSIONS.has(extname(name).toLowerCase())

async function resolveAbsolutePath(path: string): Promise<string> {
  if (typeof path !== 'string' || !path) throw new Error('Project directory path is required')
  const expanded = path === '~' ? homedir() : path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\')) ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('Project directory path must be absolute')
  return realpath(expanded)
}

export async function resolveProjectDirectory(path: string): Promise<string> {
  const resolved = await resolveAbsolutePath(path)
  if (!(await stat(resolved)).isDirectory()) throw new Error('Project path must be a directory')
  return resolved
}

function isUnreadableChild(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return isMissing(error) || isPermissionDenied(error) || code === 'ELOOP'
}

/**
 * Tri-state Git marker shared by browsing and search: a denied probe is unknown (`null` plus the
 * reason), never a false "not a repository". Other errors are not this probe's to classify.
 */
async function probeGit(path: string): Promise<{ git: boolean | null; warning?: string }> {
  try {
    const marker = await stat(join(path, '.git'))
    return { git: marker.isDirectory() || marker.isFile() }
  } catch (error) {
    if (isMissing(error)) return { git: false }
    if (isPermissionDenied(error)) return { git: null, warning: (error as Error).message }
    throw error
  }
}

/**
 * Breadth-first name search below one folder, so shallow matches come first. It never follows
 * symlinks (no cycles, no escaping the folder) and does not descend into Git repositories: a
 * repository is the project itself, and its source tree would flood the results and the budget.
 * Unreadable subfolders are skipped; only the searched folder itself must be readable.
 */
export async function searchProjectDirectories(
  path: string,
  query: string,
  showHidden = false,
  signal?: AbortSignal
): Promise<ProjectDirectorySearch> {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Search query is required')
  if (typeof showHidden !== 'boolean') throw new Error('Show hidden folders must be a boolean')
  const root = await resolveProjectDirectory(path)
  const home = homedir()
  const needle = query.trim().toLocaleLowerCase()
  const directories: ProjectDirectorySearch['directories'] = []
  let level = [root]
  let operations = 0
  let truncated = false
  const stopped = () => ({ path: root, query, directories, truncated: true })
  for (let depth = 0; level.length && depth < SEARCH_DEPTH_LIMIT; depth++) {
    const next: string[] = []
    for (let offset = 0; offset < level.length; offset += STAT_BATCH_SIZE) {
      // A superseded or cancelled search must stop before its next batch of filesystem work.
      signal?.throwIfAborted()
      const batch = level.slice(offset, offset + STAT_BATCH_SIZE)
      operations += batch.length
      const listings = await Promise.all(batch.map(async (parent) => {
        try {
          return { parent, entries: await readdir(parent, { withFileTypes: true }) }
        } catch (error) {
          if (parent === root || !isUnreadableChild(error)) throw error
          return { parent, entries: [] }
        }
      }))
      const children = listings.flatMap(({ parent, entries }) => entries
        .filter((entry) => entry.isDirectory() && (showHidden || !entry.name.startsWith('.')) && entry.name !== '.git')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({ parent, name: entry.name, path: join(parent, entry.name) })))
      for (let probeOffset = 0; probeOffset < children.length; probeOffset += STAT_BATCH_SIZE) {
        signal?.throwIfAborted()
        if (operations >= SEARCH_OPERATION_LIMIT) return stopped()
        const probes = children.slice(probeOffset, probeOffset + STAT_BATCH_SIZE)
        operations += probes.length
        const markers = await Promise.all(probes.map((child) => probeGit(child.path)))
        probes.forEach((child, index) => {
          const { git, warning } = markers[index]
          if (child.name.toLocaleLowerCase().includes(needle)) {
            if (directories.length < SEARCH_RESULT_LIMIT) {
              directories.push({ name: child.name, path: child.path, relativePath: relative(root, child.path), git, ...(warning ? { warning } : {}) })
            } else truncated = true
          }
          // Unknown (denied) children are not entered either: their readdir would fail the same way.
          if (git === false && !SEARCH_SKIPPED.has(child.name) && !(child.name === 'Library' && child.parent === home)) next.push(child.path)
        })
        if (truncated) return stopped()
      }
      if (operations >= SEARCH_OPERATION_LIMIT) return stopped()
    }
    level = next
  }
  return { path: root, query, directories, truncated: truncated || level.length > 0 }
}

export async function browseProjectDirectories(
  path?: string,
  showHidden = false,
  includeFiles = false
): Promise<ProjectDirectoryListing> {
  if (typeof showHidden !== 'boolean') throw new Error('Show hidden folders must be a boolean')
  if (typeof includeFiles !== 'boolean') throw new Error('Include files must be a boolean')
  let current = await resolveAbsolutePath(path === undefined ? homedir() : path)
  let file: string | undefined
  // A typed plugin file opens its folder with that file selected, as a native file dialog would.
  const target = await stat(current)
  if (!target.isDirectory()) {
    if (!includeFiles || !target.isFile() || !isPluginFileName(current)) throw new Error('Project path must be a directory')
    file = current
    current = dirname(current)
  }
  const home = homedir()
  const root = parse(current).root
  const breadcrumbs = [{ name: root, path: root }]
  let crumbPath = root
  for (const name of current.slice(root.length).split(sep).filter(Boolean)) {
    crumbPath = join(crumbPath, name)
    breadcrumbs.push({ name, path: crumbPath })
  }

  const entries = (await readdir(current, { withFileTypes: true }))
    .filter((entry) => (showHidden || !entry.name.startsWith('.')) && (entry.isDirectory() || entry.isSymbolicLink() || (includeFiles && entry.isFile() && isPluginFileName(entry.name))))
    .sort((a, b) => a.name.localeCompare(b.name))
  const directories: ProjectDirectoryListing['directories'] = []
  const files: ProjectDirectoryListing['directories'] = []
  scan: for (let offset = 0; offset < entries.length; offset += STAT_BATCH_SIZE) {
    const batch = await Promise.all(entries.slice(offset, offset + STAT_BATCH_SIZE).map(async (entry) => {
      const childPath = join(current, entry.name)
      // Files sort after every directory, so once the file share is full only directories still matter.
      if (entry.isFile() && files.length > DIRECTORY_LIMIT) return null
      try {
        const metadata = await stat(childPath)
        if (metadata.isDirectory()) return { name: entry.name, path: childPath, ...(await probeGit(childPath)) }
        if (includeFiles && metadata.isFile() && isPluginFileName(entry.name)) {
          return { name: entry.name, path: childPath, git: false, kind: 'file' as const }
        }
        return null
      } catch (error) {
        // A child is an independent inspection boundary. A denied child/Git probe must not hide its
        // readable siblings: return an explicit unknown marker and warning, never a false Git result.
        if (isPermissionDenied(error)) {
          // An unresolvable link named like a plugin file is far more likely a file than a folder.
          if (entry.isFile() || (includeFiles && isPluginFileName(entry.name))) return null
          return { name: entry.name, path: childPath, git: null, warning: error instanceof Error ? error.message : String(error) }
        }
        // Broken/cyclic links and children removed during this scan are not browseable. Only this
        // child boundary skips ELOOP; resolving the directory requested by the user still rejects it.
        if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error
        return null
      }
    }))
    for (const directory of batch) {
      if (directory) {
        if ('kind' in directory && directory.kind === 'file') {
          if (files.length <= DIRECTORY_LIMIT) files.push(directory)
        } else directories.push(directory)
      }
      if (directories.length > DIRECTORY_LIMIT) break scan
    }
  }
  return {
    path: current,
    home,
    parent: current === root ? null : dirname(current),
    breadcrumbs,
    ...(file ? { file } : {}),
    directories: [...directories, ...files].slice(0, DIRECTORY_LIMIT),
    truncated: directories.length + files.length > DIRECTORY_LIMIT
  }
}
