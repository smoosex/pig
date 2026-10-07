import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { OpenProjectSessionsState, OpenProjectWorkspace } from '../shared/api'
import { pigDir, pigPath } from './pig-dir'
import { changesTabId } from '../shared/tab-ids'

interface OpenProjectSessionsFile extends OpenProjectSessionsState {
  version: 4
}

/**
 * The strip's order, kept a permutation of the tabs that can actually come back: an id in the order is
 * a member placed there, a member the order never mentions is appended in its own arrival order, and an
 * id with no member behind it is dropped. A file tab is never a member, so it cannot be written here.
 * A worktree nobody has ever dragged reads back the shape it had before ordering existed.
 */
function normalizeOrder(order: unknown, members: string[]): string[] {
  const known = Array.isArray(order)
    ? [...new Set(order.filter((id): id is string => typeof id === 'string' && members.includes(id)))]
    : []
  return [...known, ...members.filter((id) => !known.includes(id))]
}

const emptyState = (): OpenProjectSessionsState => ({
  currentCwd: null,
  workspaces: [],
  chatOrder: [],
  activeChatTabId: null
})

function filePath(): string {
  return pigPath('open-project-sessions.json')
}

function normalizeWorkspace(value: unknown): OpenProjectWorkspace | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<OpenProjectWorkspace> & { diffTabs?: unknown; activeSessionId?: string | null }
  if (typeof item.cwd !== 'string' || !item.cwd) return null
  const sessionIds = Array.isArray(item.sessionIds)
    ? [...new Set(item.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const activeSessionId = typeof item.activeSessionId === 'string' && sessionIds.includes(item.activeSessionId)
    ? item.activeSessionId
    : sessionIds.at(-1) ?? null
  // Version 2 kept a list of per-file diff tabs, which one 全部变更 tab replaced.
  const changesOpen = typeof item.changesOpen === 'boolean'
    ? item.changesOpen
    : Array.isArray(item.diffTabs) && item.diffTabs.length > 0
  // Files written before either tab kind existed only have `activeSessionId` to restore from.
  const activeTabId = typeof item.activeTabId === 'string' && item.activeTabId
    ? item.activeTabId
    : activeSessionId
  const cwd = resolve(item.cwd)
  // The changes tab takes part in the order only while it is open, which is what `changesOpen` records.
  const members = changesOpen ? [...sessionIds, changesTabId(cwd)] : sessionIds
  return {
    cwd,
    sessionIds,
    activeSessionId,
    changesOpen,
    activeTabId,
    tabOrder: normalizeOrder(item.tabOrder, members)
  }
}

/**
 * Which chats the strip was holding open, and which one it was showing. The list is both membership and
 * order here: nothing else records that a chat was open at all. An id whose directory has since been
 * taken back is dropped by the restore, not reported.
 */
function normalizeChatState(raw: Partial<OpenProjectSessionsFile>): Pick<
  OpenProjectSessionsState,
  'chatOrder' | 'activeChatTabId'
> {
  const chatOrder = Array.isArray(raw.chatOrder)
    ? [...new Set(raw.chatOrder.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const activeChatTabId = typeof raw.activeChatTabId === 'string' && chatOrder.includes(raw.activeChatTabId)
    ? raw.activeChatTabId
    : null
  return { chatOrder, activeChatTabId }
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
  } catch (error) {
    await setAsideCorruptFile()
    throw new Error(`Invalid open-project-sessions JSON: ${filePath()}`, { cause: error })
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
    workspaces: [...byCwd.values()],
    ...normalizeChatState(raw)
  }
}

async function writeState(state: OpenProjectSessionsState): Promise<void> {
  await mkdir(pigDir(), { recursive: true })
  const path = filePath()
  const temporary = `${path}.${process.pid}.tmp`
  const body: OpenProjectSessionsFile = { version: 4, ...state }
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
      workspace = { cwd: target, sessionIds: [], activeSessionId: null, changesOpen: false, activeTabId: null, tabOrder: [] }
      state.workspaces.push(workspace)
    }
    if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
    workspace.activeSessionId ??= sessionId
    workspace.activeTabId ??= sessionId
    // A session main just learned about belongs at the end of the strip, which is where the renderer
    // appends it too; keeping the two in step is what makes an un-dragged order invisible on restore.
    workspace.tabOrder = normalizeOrder(workspace.tabOrder, workspace.changesOpen
      ? [...workspace.sessionIds, changesTabId(target)]
      : workspace.sessionIds)
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
      if (workspace.activeTabId === sessionId) workspace.activeTabId = workspace.activeSessionId
    }
    state.workspaces = state.workspaces.filter(
      (workspace) => workspace.sessionIds.length > 0 || workspace.changesOpen
    )
  })
}

/**
 * Where a worktree was left: which session was active, and which of its tabs was on the strip. The two
 * are not the same — a changes tab has no session behind it — so the renderer states both and this
 * stores both rather than guessing the tab from the session.
 */
export function selectOpenProjectWorkspace(
  cwd: string,
  sessionId: string | null,
  activeTabId: string | null
): Promise<void> {
  const target = resolve(cwd)
  return mutate((state) => {
    state.currentCwd = target
    let workspace = state.workspaces.find((item) => item.cwd === target)
    if (!workspace && sessionId) {
      workspace = {
        cwd: target,
        sessionIds: [sessionId],
        activeSessionId: sessionId,
        changesOpen: false,
        activeTabId: activeTabId ?? sessionId,
        tabOrder: [sessionId]
      }
      state.workspaces.push(workspace)
    } else if (workspace) {
      if (sessionId && !workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
      workspace.activeSessionId = sessionId
      // Never an active session without an active tab: a workspace with no strip selection falls back
      // to the session it just recorded.
      workspace.activeTabId = activeTabId ?? sessionId
    }
  })
}

/** The renderer owns the strip: this mirrors whether one worktree keeps its 全部变更 tab open. */
export function saveOpenProjectChangesTab(
  cwd: string,
  open: boolean,
  activeTabId: string | null
): Promise<void> {
  const target = resolve(cwd)
  return mutate((state) => {
    state.currentCwd = target
    let workspace = state.workspaces.find((item) => item.cwd === target)
    if (!workspace) {
      workspace = { cwd: target, sessionIds: [], activeSessionId: null, changesOpen: false, activeTabId: null, tabOrder: [] }
      state.workspaces.push(workspace)
    }
    workspace.changesOpen = open
    workspace.activeTabId = activeTabId
    workspace.tabOrder = normalizeOrder(workspace.tabOrder, open
      ? [...workspace.sessionIds, changesTabId(target)]
      : workspace.sessionIds)
  })
}

/**
 * The order a worktree's strip was dragged into. Membership is not this call's to decide: the ids are
 * arranged over the sessions already recorded, so a reorder cannot open a tab or close one.
 */
export function saveOpenProjectTabOrder(cwd: string, tabIds: string[]): Promise<void> {
  const target = resolve(cwd)
  return mutate((state) => {
    const workspace = state.workspaces.find((item) => item.cwd === target)
    if (!workspace) return
    workspace.tabOrder = normalizeOrder(tabIds, workspace.changesOpen
      ? [...workspace.sessionIds, changesTabId(target)]
      : workspace.sessionIds)
  })
}

/**
 * The chats half's open tabs and which was showing. Unlike a worktree's, this list is written whole by
 * the renderer: a chat has no worktree to accumulate its sessions under, so membership and order are the
 * same list, and an empty one is a strip with nothing open rather than a read that failed.
 *
 * A `null` active id means the reader was looking at something else — the worktree's tab, or nothing at
 * all — which is not a new choice about chats, so the chat the half was last left on keeps its place
 * while it stays open. Only a list that no longer holds it falls back to the home.
 */
export function saveOpenChatTabs(tabIds: string[], activeTabId: string | null): Promise<void> {
  const next = normalizeChatState({ chatOrder: tabIds }).chatOrder
  return mutate((state) => {
    const chosen = typeof activeTabId === 'string' && next.includes(activeTabId) ? activeTabId : null
    state.chatOrder = next
    state.activeChatTabId = chosen
      ?? (state.activeChatTabId && next.includes(state.activeChatTabId) ? state.activeChatTabId : null)
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
