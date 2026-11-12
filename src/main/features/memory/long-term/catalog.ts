/** UI-only project labels, resolved through the same identity as memory access. Never rename scopes. */
import { basename } from 'node:path'
import type { MemoryFileListItem } from '../../../../shared/long-term-memory'
import { listOpenedCwds } from '../../../opened-projects'
import { sessionWorkspace } from '../../../sandbox/workspace'
import { memoryRoot, projectMemoryKey } from './files'
import { inspectMemoryDirectory } from './inventory'

export async function listMemoryFiles(): Promise<MemoryFileListItem[]> {
  const files = inspectMemoryDirectory(memoryRoot()).files
  const ids = new Set(files.filter(file => file.path.startsWith('projects/')).map(file => file.path.split('/')[1]))
  if (!ids.size) return files
  const names = new Map((await listMemoryProjects()).map(project => [project.id, project.name]))
  return files.map(file => {
    const name = file.path.startsWith('projects/') ? names.get(file.path.split('/')[1]) : undefined
    return name ? { ...file, projectName: name } : file
  })
}

export async function listMemoryProjects(): Promise<{ id: string; name: string; cwd: string }[]> {
  const projects = new Map<string, { id: string; name: string; cwd: string }>()
  for (const cwd of await listOpenedCwds()) {
    let workspace
    try { workspace = await sessionWorkspace(cwd) }
    // Name resolution is display-only; unresolved identities are never invented.
    catch { continue }
    const id = projectMemoryKey(workspace.gitCommonDir ?? workspace.cwd)
    if (!projects.has(id)) projects.set(id, { id, name: basename(cwd) || cwd, cwd })
  }
  return [...projects.values()]
}
