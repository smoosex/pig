import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pigDir, pigPath } from './pig-dir'
import type { SidebarPrefs } from '../shared/api'

export type { SidebarPrefs } from '../shared/api'

const defaults: SidebarPrefs = {
  projectsCollapsed: false,
  chatsCollapsed: false,
  split: 0.5
}

function filePath(): string {
  return pigPath('sidebar.json')
}

function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return defaults.split
  return Math.min(0.8, Math.max(0.2, value))
}

export async function loadSidebarPrefs(): Promise<SidebarPrefs> {
  try {
    const data = JSON.parse(await readFile(filePath(), 'utf8')) as Partial<SidebarPrefs>
    return {
      projectsCollapsed: Boolean(data.projectsCollapsed),
      chatsCollapsed: Boolean(data.chatsCollapsed),
      split: clampSplit(data.split ?? defaults.split)
    }
  } catch {
    return { ...defaults }
  }
}

export async function saveSidebarPrefs(patch: Partial<SidebarPrefs>): Promise<SidebarPrefs> {
  const current = await loadSidebarPrefs()
  const next: SidebarPrefs = {
    projectsCollapsed:
      patch.projectsCollapsed === undefined ? current.projectsCollapsed : Boolean(patch.projectsCollapsed),
    chatsCollapsed: patch.chatsCollapsed === undefined ? current.chatsCollapsed : Boolean(patch.chatsCollapsed),
    split: patch.split === undefined ? current.split : clampSplit(patch.split)
  }
  await mkdir(pigDir(), { recursive: true })
  await writeFile(filePath(), `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
  return next
}
