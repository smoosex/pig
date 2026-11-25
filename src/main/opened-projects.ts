import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { pigDir, pigPath } from './pig-dir'
import { t } from './i18n'

export interface OpenedProject {
  cwd: string
  openedAt: string
  alias?: string
}

const MAX_PROJECT_ALIAS_LENGTH = 120

interface OpenedProjectsFile {
  version: number
  projects: OpenedProject[]
}

function filePath(): string {
  return pigPath('opened-projects.json')
}

function normalizeAlias(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error(t('project.invalidName'))
  const cleaned = raw.replace(/[\r\n]+/g, ' ').trim()
  if (cleaned.length > MAX_PROJECT_ALIAS_LENGTH) throw new Error(t('project.invalidName'))
  return cleaned || undefined
}

async function read(): Promise<OpenedProject[]> {
  try {
    const data = JSON.parse(await readFile(filePath(), 'utf8')) as OpenedProjectsFile
    if (!Array.isArray(data.projects)) return []
    return data.projects.flatMap((item): OpenedProject[] => {
      if (typeof item?.cwd !== 'string' || item.cwd.length === 0) return []
      const alias = typeof item.alias === 'string' && item.alias.trim() ? item.alias.trim() : undefined
      return [{
        cwd: resolve(item.cwd),
        openedAt: typeof item.openedAt === 'string' ? item.openedAt : new Date(0).toISOString(),
        ...(alias ? { alias } : {})
      }]
    })
  } catch {
    return []
  }
}

async function write(projects: OpenedProject[]): Promise<void> {
  await mkdir(pigDir(), { recursive: true })
  const body: OpenedProjectsFile = { version: 1, projects }
  await writeFileAtomic(filePath(), `${JSON.stringify(body, null, 2)}\n`)
}

let mutationQueue: Promise<void> = Promise.resolve()

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

export async function listOpenedCwds(): Promise<string[]> {
  await mutationQueue
  return (await read()).map((item) => item.cwd)
}

export async function getOpenedProjectAlias(cwd: string): Promise<string | undefined> {
  await mutationQueue
  const resolved = resolve(cwd)
  return (await read()).find((item) => item.cwd === resolved)?.alias
}

export async function renameOpenedProject(cwd: string, rawAlias: unknown): Promise<string | undefined> {
  const resolved = resolve(cwd)
  const alias = normalizeAlias(rawAlias)
  return serialize(async () => {
    const projects = await read()
    const index = projects.findIndex((item) => item.cwd === resolved)
    if (index === -1) throw new Error(t('error.projectNotOpen'))
    const current = projects[index]!
    if (current.alias === alias) return alias
    const next = [...projects]
    const { alias: _prev, ...rest } = current
    next[index] = alias ? { ...rest, alias } : rest
    await write(next)
    return alias
  })
}

export async function replaceOpenedProjectCwd(oldCwd: string, newCwd: string): Promise<void> {
  const source = resolve(oldCwd)
  const target = resolve(newCwd)
  if (source === target) return
  await serialize(async () => {
    const projects = await read()
    const sourceIndex = projects.findIndex((item) => item.cwd === source)
    if (sourceIndex === -1) throw new Error(t('error.projectNotOpen'))
    const targetIndex = projects.findIndex((item, i) => i !== sourceIndex && item.cwd === target)
    if (targetIndex !== -1) {
      // Merge into the already-open target entry, inheriting source's alias only if target had none.
      const sourceEntry = projects[sourceIndex]!
      const targetEntry = projects[targetIndex]!
      const next = projects
        .map((item, i) =>
          i === targetIndex && !targetEntry.alias && sourceEntry.alias
            ? { ...targetEntry, alias: sourceEntry.alias }
            : item
        )
        .filter((_, i) => i !== sourceIndex)
      await write(next)
      return
    }
    const next = [...projects]
    next[sourceIndex] = { ...next[sourceIndex]!, cwd: target }
    await write(next)
  })
}

export async function addOpenedProject(cwd: string, check?: () => void): Promise<string> {
  const resolved = resolve(cwd)
  return serialize(async () => {
    const projects = await read()
    check?.()
    if (!projects.some((item) => item.cwd === resolved)) {
      projects.push({ cwd: resolved, openedAt: new Date().toISOString() })
      await write(projects)
    }
    return resolved
  })
}

export async function removeOpenedProject(cwd: string): Promise<void> {
  const resolved = resolve(cwd)
  await serialize(async () => {
    await write((await read()).filter((item) => item.cwd !== resolved))
  })
}

export async function reorderOpenedProjects(cwds: unknown): Promise<string[]> {
  if (!Array.isArray(cwds)) throw new Error(t('error.projectOrderArray'))
  const resolved = cwds.map((cwd) => {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error(t('error.projectIdInvalid'))
    return resolve(cwd)
  })
  if (new Set(resolved).size !== resolved.length) throw new Error(t('error.projectOrderDuplicate'))
  return serialize(async () => {
    const projects = await read()
    if (resolved.length !== projects.length) throw new Error(t('error.projectListChanged'))
    const byCwd = new Map(projects.map((project) => [project.cwd, project]))
    if (resolved.some((cwd) => !byCwd.has(cwd))) throw new Error(t('error.projectListChanged'))
    const ordered = resolved.map((cwd) => byCwd.get(cwd)!)
    await write(ordered)
    return ordered.map((project) => project.cwd)
  })
}
