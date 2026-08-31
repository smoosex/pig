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

export async function listOpenedCwds(): Promise<string[]> {
  return (await read()).map((item) => item.cwd)
}

export async function addOpenedProject(cwd: string): Promise<string> {
  const resolved = resolve(cwd)
  const projects = await read()
  if (!projects.some((item) => item.cwd === resolved)) {
    projects.push({ cwd: resolved, openedAt: new Date().toISOString() })
    await write(projects)
  }
  return resolved
}

export async function removeOpenedProject(cwd: string): Promise<void> {
  const resolved = resolve(cwd)
  await write((await read()).filter((item) => item.cwd !== resolved))
}
