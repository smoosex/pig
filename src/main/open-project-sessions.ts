import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { OpenProjectSessionsState, OpenProjectWorkspace } from '../shared/api'
import { pigDir, pigPath } from './pig-dir'

interface OpenProjectSessionsFile extends OpenProjectSessionsState {
  version: 1
}

const emptyState = (): OpenProjectSessionsState => ({ currentCwd: null, workspaces: [] })

function filePath(): string {
  return pigPath('open-project-sessions.json')
}

function normalizeWorkspace(value: unknown): OpenProjectWorkspace | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<OpenProjectWorkspace>
  if (typeof item.cwd !== 'string' || !item.cwd) return null
  const sessionIds = Array.isArray(item.sessionIds)
    ? [...new Set(item.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const activeSessionId = typeof item.activeSessionId === 'string' && sessionIds.includes(item.activeSessionId)
    ? item.activeSessionId
    : sessionIds.at(-1) ?? null
  return { cwd: resolve(item.cwd), sessionIds, activeSessionId }
}

/** A file that cannot be parsed is kept aside so the next write cannot silently drop it. */
async function setAsideCorruptFile(): Promise<void> {
  const backup = `${filePath()}.corrupt`
  await rm(backup, { force: true })
  await rename(filePath(), backup)
}

async function readState(): Promise<OpenProjectSessionsState> {
  let contents: string
  try {
    contents = await readFile(filePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    await setAsideCorruptFile()
    return emptyState()
  }
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<OpenProjectSessionsFile>
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.map(normalizeWorkspace).filter((item): item is OpenProjectWorkspace => item !== null)
    : []
  const byCwd = new Map<string, OpenProjectWorkspace>()
  for (const workspace of workspaces) byCwd.set(workspace.cwd, workspace)
  const current = typeof raw.currentCwd === 'string' && raw.currentCwd
    ? resolve(raw.currentCwd)
    : null
  return {
    currentCwd: current,
    workspaces: [...byCwd.values()]
  }
}

async function writeState(state: OpenProjectSessionsState): Promise<void> {
  await mkdir(pigDir(), { recursive: true })
  const path = filePath()
  const temporary = `${path}.${process.pid}.tmp`
  const body: OpenProjectSessionsFile = { version: 1, ...state }
  try {
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

function mutate(update: (state: OpenProjectSessionsState) => void): Promise<void> {
  const result = mutationQueue.then(async () => {
    // A read that failed for any reason other than a missing file must not turn into a write.
    const state = await readState()
    update(state)
    await writeState(state)
  })
  mutationQueue = result.catch(() => {})
  return result
}

export async function loadOpenProjectSessions(): Promise<OpenProjectSessionsState> {
  await mutationQueue
  return readState()
}

export function rememberOpenProjectSession(cwd: string, sessionId: string): Promise<void> {
  const target = resolve(cwd)
  return mutate((state) => {
    let workspace = state.workspaces.find((item) => item.cwd === target)
    if (!workspace) {
      workspace = { cwd: target, sessionIds: [], activeSessionId: null }
      state.workspaces.push(workspace)
    }
    if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
    workspace.activeSessionId ??= sessionId
  })
}

export function forgetOpenProjectSession(sessionId: string): Promise<void> {
  return mutate((state) => {
    for (const workspace of state.workspaces) {
      const index = workspace.sessionIds.indexOf(sessionId)
      if (index === -1) continue
      workspace.sessionIds.splice(index, 1)
      if (workspace.activeSessionId === sessionId) {
        workspace.activeSessionId = workspace.sessionIds.at(-1) ?? null
      }
    }
    state.workspaces = state.workspaces.filter((workspace) => workspace.sessionIds.length > 0)
  })
}

export function selectOpenProjectWorkspace(cwd: string, sessionId: string | null): Promise<void> {
  const target = resolve(cwd)
  return mutate((state) => {
    state.currentCwd = target
    let workspace = state.workspaces.find((item) => item.cwd === target)
    if (!workspace && sessionId) {
      workspace = { cwd: target, sessionIds: [sessionId], activeSessionId: sessionId }
      state.workspaces.push(workspace)
    } else if (workspace) {
      if (sessionId && !workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
      workspace.activeSessionId = sessionId
    }
  })
}

export function removeOpenProjectWorkspaces(cwds: Iterable<string>): Promise<void> {
  const targets = new Set([...cwds].map((cwd) => resolve(cwd)))
  return mutate((state) => {
    state.workspaces = state.workspaces.filter((workspace) => !targets.has(workspace.cwd))
    if (state.currentCwd && targets.has(state.currentCwd)) state.currentCwd = null
  })
}

export async function flushOpenProjectSessions(): Promise<void> {
  await mutationQueue
}
