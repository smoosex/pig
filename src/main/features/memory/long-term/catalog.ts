/** UI-only project labels, resolved through the same identity as memory access. Never rename scopes. */
import { basename } from 'node:path'
import type { MemoryFileListItem } from '../../../../shared/long-term-memory'
import { listOpenedCwds } from '../../../opened-projects'
import { sessionWorkspace } from '../../../sandbox/workspace'
import { MemoryFiles, memoryRoot, projectMemoryKey } from './files'

export async function listMemoryFiles(): Promise<MemoryFileListItem[]> {
  const files = new MemoryFiles(memoryRoot()).list()
  const ids = new Set(files.filter(file => file.path.startsWith('projects/')).map(file => file.path.split('/')[1]))
  if (!ids.size) return files
  const names = new Map<string, string>()
  for (const cwd of await listOpenedCwds()) {
    let workspace
    try { workspace = await sessionWorkspace(cwd) }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    const id = projectMemoryKey(workspace.gitCommonDir ?? workspace.cwd)
    if (ids.has(id) && !names.has(id)) names.set(id, basename(cwd) || cwd)
  }
  return files.map(file => {
    const name = file.path.startsWith('projects/') ? names.get(file.path.split('/')[1]) : undefined
    return name ? { ...file, projectName: name } : file
  })
}
