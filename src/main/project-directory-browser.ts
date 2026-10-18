// Browse one directory at a time; filesystem paths are resolved before crossing the IPC boundary.
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, sep } from 'node:path'
import type { ProjectDirectoryListing } from '../shared/api'

const DIRECTORY_LIMIT = 500
const STAT_BATCH_SIZE = 32

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM'
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function resolveProjectDirectory(path: string): Promise<string> {
  if (typeof path !== 'string' || !path) throw new Error('Project directory path is required')
  const expanded = path === '~' ? homedir() : path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\')) ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('Project directory path must be absolute')
  const resolved = await realpath(expanded)
  if (!(await stat(resolved)).isDirectory()) throw new Error('Project path must be a directory')
  return resolved
}

export async function browseProjectDirectories(
  path?: string,
  showHidden = false
): Promise<ProjectDirectoryListing> {
  if (typeof showHidden !== 'boolean') throw new Error('Show hidden folders must be a boolean')
  const current = await resolveProjectDirectory(path === undefined ? homedir() : path)
  const home = homedir()
  const root = parse(current).root
  const breadcrumbs = [{ name: root, path: root }]
  let crumbPath = root
  for (const name of current.slice(root.length).split(sep).filter(Boolean)) {
    crumbPath = join(crumbPath, name)
    breadcrumbs.push({ name, path: crumbPath })
  }

  const entries = (await readdir(current, { withFileTypes: true }))
    .filter((entry) => (showHidden || !entry.name.startsWith('.')) && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name))
  const directories: ProjectDirectoryListing['directories'] = []
  scan: for (let offset = 0; offset < entries.length; offset += STAT_BATCH_SIZE) {
    const batch = await Promise.all(entries.slice(offset, offset + STAT_BATCH_SIZE).map(async (entry) => {
      const childPath = join(current, entry.name)
      try {
        if (!(await stat(childPath)).isDirectory()) return null
        let git = false
        try {
          const marker = await stat(join(childPath, '.git'))
          git = marker.isDirectory() || marker.isFile()
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        return { name: entry.name, path: childPath, git }
      } catch (error) {
        // A child is an independent inspection boundary. A denied child/Git probe must not hide its
        // readable siblings: return an explicit unknown marker and warning, never a false Git result.
        if (isPermissionDenied(error)) {
          return { name: entry.name, path: childPath, git: null, warning: error instanceof Error ? error.message : String(error) }
        }
        // Broken/cyclic links and children removed during this scan are not browseable. Only this
        // child boundary skips ELOOP; resolving the directory requested by the user still rejects it.
        if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error
        return null
      }
    }))
    for (const directory of batch) {
      if (directory) directories.push(directory)
      if (directories.length > DIRECTORY_LIMIT) break scan
    }
  }
  return {
    path: current,
    home,
    parent: current === root ? null : dirname(current),
    breadcrumbs,
    directories: directories.slice(0, DIRECTORY_LIMIT),
    truncated: directories.length > DIRECTORY_LIMIT
  }
}
