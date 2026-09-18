import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { pigDir, pigPath } from './pig-dir'
import {
  DEFAULT_REVIEW_WIDTH,
  MAX_REVIEW_WIDTH,
  MIN_REVIEW_WIDTH,
  type SidebarPrefs
} from '../shared/api'

export type { SidebarPrefs } from '../shared/api'

const defaults: SidebarPrefs = {
  projectsCollapsed: false,
  chatsCollapsed: false,
  split: 0.5,
  reviewOpen: false,
  reviewWidth: DEFAULT_REVIEW_WIDTH
}

function filePath(): string {
  return pigPath('sidebar.json')
}

/** A file that cannot be parsed is kept aside so the next write cannot silently drop it. */
async function setAsideCorruptFile(): Promise<void> {
  const backup = `${filePath()}.corrupt`
  await rm(backup, { force: true })
  await rename(filePath(), backup)
}

function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return defaults.split
  return Math.min(0.8, Math.max(0.2, value))
}

function clampReviewWidth(value: number): number {
  if (!Number.isFinite(value)) return defaults.reviewWidth
  return Math.min(MAX_REVIEW_WIDTH, Math.max(MIN_REVIEW_WIDTH, Math.round(value)))
}

export async function loadSidebarPrefs(): Promise<SidebarPrefs> {
  let contents: string
  try {
    contents = await readFile(filePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }
    // A read that failed for any other reason is not a preference that was never set: the caller has to hear
    // it, and a write built on defaults it could not read would drop what is still in the file.
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    await setAsideCorruptFile()
    return { ...defaults }
  }
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<SidebarPrefs>
  return {
    projectsCollapsed: Boolean(data.projectsCollapsed),
    chatsCollapsed: Boolean(data.chatsCollapsed),
    split: clampSplit(data.split ?? defaults.split),
    reviewOpen: Boolean(data.reviewOpen),
    reviewWidth: clampReviewWidth(data.reviewWidth ?? defaults.reviewWidth)
  }
}

export async function saveSidebarPrefs(patch: Partial<SidebarPrefs>): Promise<SidebarPrefs> {
  const current = await loadSidebarPrefs()
  const next: SidebarPrefs = {
    projectsCollapsed:
      patch.projectsCollapsed === undefined ? current.projectsCollapsed : Boolean(patch.projectsCollapsed),
    chatsCollapsed: patch.chatsCollapsed === undefined ? current.chatsCollapsed : Boolean(patch.chatsCollapsed),
    split: patch.split === undefined ? current.split : clampSplit(patch.split),
    reviewOpen: patch.reviewOpen === undefined ? current.reviewOpen : Boolean(patch.reviewOpen),
    reviewWidth:
      patch.reviewWidth === undefined ? current.reviewWidth : clampReviewWidth(patch.reviewWidth)
  }
  await mkdir(pigDir(), { recursive: true })
  await writeFile(filePath(), `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
  return next
}
