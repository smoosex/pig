import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type OpenedProjectsModule = typeof import('../src/main/opened-projects')

let root = ''
let opened: OpenedProjectsModule
const previousPigDir = process.env.PIG_DIR

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pig-opened-projects-'))
  process.env.PIG_DIR = root
  opened = await import('../src/main/opened-projects')
})

beforeEach(async () => {
  await rm(join(root, 'opened-projects.json'), { force: true })
})

afterAll(async () => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  await rm(root, { recursive: true, force: true })
})

function project(name: string): string {
  return join(root, name)
}

async function readProjects(): Promise<{ cwd: string; openedAt: string }[]> {
  const data = JSON.parse(await readFile(join(root, 'opened-projects.json'), 'utf8')) as {
    projects: { cwd: string; openedAt: string }[]
  }
  return data.projects
}

describe('opened project ordering', () => {
  test('serializes concurrent additions and appends new projects', async () => {
    const [a, b, c] = [project('a'), project('b'), project('c')]
    await Promise.all([opened.addOpenedProject(a), opened.addOpenedProject(b)])
    await opened.removeOpenedProject(a)
    await opened.addOpenedProject(c)
    expect(await opened.listOpenedCwds()).toEqual([b, c])
  })

  test('persists a reordered list without changing openedAt', async () => {
    const [a, b, c] = [project('a'), project('b'), project('c')]
    await opened.addOpenedProject(a)
    await opened.addOpenedProject(b)
    await opened.addOpenedProject(c)
    const before = await readProjects()

    await opened.reorderOpenedProjects([c, a, b])

    const after = await readProjects()
    expect(after.map((item) => item.cwd)).toEqual([c, a, b])
    expect(new Map(before.map((item) => [item.cwd, item.openedAt]))).toEqual(
      new Map(after.map((item) => [item.cwd, item.openedAt]))
    )
  })

  test('rejects duplicate or unknown project identifiers without writing', async () => {
    const [a, b] = [project('a'), project('b')]
    await opened.addOpenedProject(a)
    await opened.addOpenedProject(b)
    const before = await readFile(join(root, 'opened-projects.json'), 'utf8')

    await expect(opened.reorderOpenedProjects([a, a])).rejects.toThrow()
    await expect(opened.reorderOpenedProjects([a, project('missing')])).rejects.toThrow()
    expect(await readFile(join(root, 'opened-projects.json'), 'utf8')).toBe(before)
  })

  test('surfaces save failures and leaves the existing order intact', async () => {
    const [a, b] = [project('a'), project('b')]
    await opened.addOpenedProject(a)
    await opened.addOpenedProject(b)
    const before = await readFile(join(root, 'opened-projects.json'), 'utf8')

    await chmod(join(root, 'opened-projects.json'), 0o400)
    try {
      await expect(opened.reorderOpenedProjects([b, a])).rejects.toThrow()
    } finally {
      await chmod(join(root, 'opened-projects.json'), 0o600)
    }

    expect(await readFile(join(root, 'opened-projects.json'), 'utf8')).toBe(before)
  })
})
