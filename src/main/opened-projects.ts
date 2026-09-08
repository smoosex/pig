import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pigDir, pigPath } from './pig-dir'

export interface OpenedProject {
  cwd: string
  openedAt: string
}

interface OpenedProjectsFile {
  version: number
  projects: OpenedProject[]
}

function filePath(): string {
  return pigPath('opened-projects.json')
}

async function read(): Promise<OpenedProject[]> {
  try {
    const data = JSON.parse(await readFile(filePath(), 'utf8')) as OpenedProjectsFile
    if (!Array.isArray(data.projects)) return []
    return data.projects.filter((item) => typeof item?.cwd === 'string' && item.cwd.length > 0)
  } catch {
    return []
  }
}

async function write(projects: OpenedProject[]): Promise<void> {
  await mkdir(pigDir(), { recursive: true })
  const body: OpenedProjectsFile = { version: 1, projects }
  await writeFile(filePath(), `${JSON.stringify(body, null, 2)}\n`)
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

export async function addOpenedProject(cwd: string): Promise<string> {
  const resolved = resolve(cwd)
  return serialize(async () => {
    const projects = await read()
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
  if (!Array.isArray(cwds)) throw new Error('项目顺序必须是数组')
  const resolved = cwds.map((cwd) => {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('项目标识无效')
    return resolve(cwd)
  })
  if (new Set(resolved).size !== resolved.length) throw new Error('项目顺序包含重复项目')
  return serialize(async () => {
    const projects = await read()
    if (resolved.length !== projects.length) throw new Error('项目列表已变化，请重试')
    const byCwd = new Map(projects.map((project) => [project.cwd, project]))
    if (resolved.some((cwd) => !byCwd.has(cwd))) throw new Error('项目列表已变化，请重试')
    const ordered = resolved.map((cwd) => byCwd.get(cwd)!)
    await write(ordered)
    return ordered.map((project) => project.cwd)
  })
}
