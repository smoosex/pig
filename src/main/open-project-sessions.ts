import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { OpenProjectSessionsState, OpenProjectWorkspace, OpenToolTab, OpenToolTabMembership } from '../shared/api'
import { pigDir, pigPath } from './pig-dir'
import { changesTabId } from '../shared/tab-ids'
import { TERMINAL_ID_PATTERN } from '../shared/terminal'
import { isBrowserUrl } from './browser/validation'
import type { LayoutNode, SavedSplitLayout } from '../shared/split-layout'

interface OpenProjectSessionsFile extends OpenProjectSessionsState {
  version: 5
}

const BROWSER_ID_PATTERN = /^browser:[a-z\d-]{1,128}$/i

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

/** A rebuilt copy of a split tree, or null when any part of it is not one the layout store could hold. */
function normalizeLayoutNode(value: unknown, paneIds: Set<string>): LayoutNode | null {
  if (!value || typeof value !== 'object') return null
  const node = value as Record<string, unknown>
  if (typeof node.id !== 'string' || !node.id) return null
  if ('tabId' in node) {
    if (typeof node.tabId !== 'string' || !node.tabId || paneIds.has(node.id)) return null
    paneIds.add(node.id)
    return { id: node.id, tabId: node.tabId }
  }
  const { children, sizes, direction } = node
  if (direction !== 'horizontal' && direction !== 'vertical') return null
  if (!Array.isArray(children) || children.length < 2 || !Array.isArray(sizes) || sizes.length !== children.length) return null
  if (sizes.some((size) => typeof size !== 'number' || !Number.isFinite(size) || size < 0) ||
    (sizes as number[]).reduce((sum, size) => sum + size, 0) <= 0) return null
  const nodes = children.map((child) => normalizeLayoutNode(child, paneIds))
  if (nodes.some((child) => child === null)) return null
  return { id: node.id, direction, children: nodes as LayoutNode[], sizes: [...sizes as number[]] }
}

function normalizeSplitLayout(value: unknown, paneIds: Set<string>): SavedSplitLayout | null {
  if (!value || typeof value !== 'object') return null
  const { root, activePaneId } = value as Record<string, unknown>
  const own = new Set<string>()
  const node = normalizeLayoutNode(root, own)
  if (!node || own.size < 2 || (activePaneId !== null && (typeof activePaneId !== 'string' || !own.has(activePaneId)))) return null
  if ([...own].some((id) => paneIds.has(id))) return null
  for (const id of own) paneIds.add(id)
  return { root: node, activePaneId }
}

/** Every group, or null when any is malformed or two groups share a pane or a tab. */
function normalizeSplitLayouts(value: unknown): SavedSplitLayout[] | null {
  if (!Array.isArray(value)) return null
  const paneIds = new Set<string>()
  const layouts = value.map((item) => normalizeSplitLayout(item, paneIds))
  if (layouts.some((layout) => layout === null)) return null
  const tabIds = (layouts as SavedSplitLayout[]).flatMap((layout) => paneTabIds(layout.root))
  return new Set(tabIds).size === tabIds.length ? layouts as SavedSplitLayout[] : null
}

function paneTabIds(node: LayoutNode): string[] {
  return 'tabId' in node ? [node.tabId] : node.children.flatMap(paneTabIds)
}

const emptyState = (): OpenProjectSessionsState => ({
  currentCwd: null,
  workspaces: [],
  chatOrder: [],
  activeChatTabId: null,
  tools: []
})

function isToolTabId(id: string): boolean {
  return BROWSER_ID_PATTERN.test(id) || TERMINAL_ID_PATTERN.test(id)
}

function normalizeTool(value: unknown): OpenToolTab | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<OpenToolTab>
  if (item.kind !== 'browser' && item.kind !== 'terminal') return null
  if (typeof item.id !== 'string' || !(item.kind === 'browser' ? BROWSER_ID_PATTERN : TERMINAL_ID_PATTERN).test(item.id)) return null
  if (typeof item.cwd !== 'string') return null
  const tool: OpenToolTab = { id: item.id, kind: item.kind, cwd: item.cwd ? resolve(item.cwd) : '' }
  if (item.kind === 'browser') {
    // The page is navigated to again on restore, so only what navigation itself accepts may come back.
    if (typeof item.url === 'string' && isBrowserUrl(item.url)) tool.url = item.url
    tool.targetSessionId = typeof item.targetSessionId === 'string' && item.targetSessionId ? item.targetSessionId : null
  }
  return tool
}

function normalizeTools(value: unknown): OpenToolTab[] {
  const byId = new Map<string, OpenToolTab>()
  for (const tool of Array.isArray(value) ? value.map(normalizeTool) : []) {
    if (tool && !byId.has(tool.id)) byId.set(tool.id, tool)
  }
  return [...byId.values()]
}

/** What a worktree's order arranges: its sessions, its open changes tab, then its browsers and terminals. */
function workspaceMembers(workspace: Pick<OpenProjectWorkspace, 'cwd' | 'sessionIds' | 'changesOpen'>, tools: OpenToolTab[]): string[] {
  return [
    ...workspace.sessionIds,
    ...(workspace.changesOpen ? [changesTabId(workspace.cwd)] : []),
    ...tools.filter((tool) => tool.cwd === workspace.cwd).map((tool) => tool.id)
  ]
}

function filePath(): string {
  return pigPath('open-project-sessions.json')
}

function normalizeWorkspace(value: unknown, tools: OpenToolTab[]): OpenProjectWorkspace | null {
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
  const members = workspaceMembers({ cwd, sessionIds, changesOpen }, tools)
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
  // Files before version 5 had no tool tabs, which reads as none open.
  const tools = normalizeTools(raw.tools)
  // Panes name tabs that may not come back; the renderer drops those when it restores the layout.
  // Before several groups, the file held one `split`; it reads as the only group.
  const legacy = (raw as { split?: unknown }).split
  const splits = normalizeSplitLayouts(raw.splits ?? (legacy === undefined ? [] : [legacy])) ?? []
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.map((item) => normalizeWorkspace(item, tools)).filter((item): item is OpenProjectWorkspace => item !== null)
    : []
  const byCwd = new Map<string, OpenProjectWorkspace>()
  for (const workspace of workspaces) byCwd.set(workspace.cwd, workspace)
  const current = typeof raw.currentCwd === 'string' && raw.currentCwd
    ? resolve(raw.currentCwd)
    : null
  return {
    currentCwd: current,
    workspaces: [...byCwd.values()],
    ...chatStateFor(normalizeChatState(raw), tools),
    tools,
    ...(splits.length ? { splits } : {})
  }
}

/** The chats half's order names a tool tab only while that tab is open there. */
function chatStateFor(
  chats: Pick<OpenProjectSessionsState, 'chatOrder' | 'activeChatTabId'>,
  tools: OpenToolTab[]
): Pick<OpenProjectSessionsState, 'chatOrder' | 'activeChatTabId'> {
  const chatTools = new Set(tools.filter((tool) => tool.cwd === '').map((tool) => tool.id))
  const chatOrder = chats.chatOrder.filter((id) => !isToolTabId(id) || chatTools.has(id))
  return {
    chatOrder,
    activeChatTabId: chats.activeChatTabId && chatOrder.includes(chats.activeChatTabId) ? chats.activeChatTabId : null
  }
}

async function writeState(state: OpenProjectSessionsState): Promise<void> {
  await mkdir(pigDir(), { recursive: true })
  const path = filePath()
  const temporary = `${path}.${process.pid}.tmp`
  const body: OpenProjectSessionsFile = { version: 5, ...state }
  try {
    // Saved browser URLs keep their query and hash so pages reopen where they were, and those can carry tokens.
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
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
    workspace.tabOrder = normalizeOrder(workspace.tabOrder, workspaceMembers(workspace, state.tools))
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
      (workspace) => workspace.sessionIds.length > 0 || workspace.changesOpen ||
        state.tools.some((tool) => tool.cwd === workspace.cwd)
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
    workspace.tabOrder = normalizeOrder(workspace.tabOrder, workspaceMembers(workspace, state.tools))
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
    workspace.tabOrder = normalizeOrder(tabIds, workspaceMembers(workspace, state.tools))
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
  return mutate((state) => {
    const next = chatStateFor(normalizeChatState({ chatOrder: tabIds }), state.tools).chatOrder
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
    state.tools = state.tools.filter((tool) => !targets.has(tool.cwd))
    if (state.currentCwd && targets.has(state.currentCwd)) state.currentCwd = null
  })
}

/**
 * Which browser and terminal tabs are open, written whole by the renderer. A tab seen for the first
 * time joins the end of its strip, which is where the renderer appends it; a browser keeps the page
 * main last recorded for it, since the renderer never knows where a page has navigated.
 */
export function saveOpenToolTabs(tabs: OpenToolTabMembership[]): Promise<void> {
  const next = normalizeTools(tabs)
  if (!Array.isArray(tabs) || next.length !== tabs.length) throw new Error('Invalid open tool tabs')
  return mutate((state) => {
    const previous = new Map(state.tools.map((tool) => [tool.id, tool]))
    state.tools = next.map((tool) => {
      const url = previous.get(tool.id)?.url
      return url ? { ...tool, url } : tool
    })
    for (const tool of state.tools) {
      if (previous.has(tool.id)) continue
      if (!tool.cwd) {
        if (!state.chatOrder.includes(tool.id)) state.chatOrder.push(tool.id)
        continue
      }
      let workspace = state.workspaces.find((item) => item.cwd === tool.cwd)
      if (!workspace) {
        workspace = { cwd: tool.cwd, sessionIds: [], activeSessionId: null, changesOpen: false, activeTabId: null, tabOrder: [] }
        state.workspaces.push(workspace)
      }
      workspace.tabOrder.push(tool.id)
    }
    for (const workspace of state.workspaces) {
      workspace.tabOrder = normalizeOrder(workspace.tabOrder, workspaceMembers(workspace, state.tools))
    }
    Object.assign(state, chatStateFor(state, state.tools))
  })
}

// Pages can commit faster than the file is rewritten (in-page routes, hash updates): the latest URL per
// browser waits here and every pending one lands in the next single write.
const pendingBrowserUrls = new Map<string, string>()
let browserUrlWrite: Promise<void> | null = null

/** Records a browser's committed page; a browser the renderer has not recorded as open is ignored. */
export function saveBrowserTabUrl(browserId: string, url: string): Promise<void> {
  pendingBrowserUrls.set(browserId, url)
  if (browserUrlWrite) return browserUrlWrite
  const write = mutate((state) => {
    // From here a new commit needs a later write; this one has already taken what is pending.
    browserUrlWrite = null
    for (const tool of state.tools) {
      const pending = pendingBrowserUrls.get(tool.id)
      if (tool.kind === 'browser' && pending && isBrowserUrl(pending)) tool.url = pending
    }
    pendingBrowserUrls.clear()
  })
  browserUrlWrite = write
  // The failure still reaches every caller through `write`. A read that failed before the update ran
  // must not leave this write looking scheduled, or no later commit would ever be saved; the pending
  // URLs stay for the next one.
  write.then(undefined, () => { if (browserUrlWrite === write) browserUrlWrite = null })
  return write
}

/** The renderer's split groups, written as they change; an empty list once nothing is split. */
export function saveOpenSplitLayouts(layouts: unknown): Promise<void> {
  const splits = normalizeSplitLayouts(layouts)
  if (!splits) throw new Error('Invalid split layout')
  return mutate((state) => {
    if (splits.length) state.splits = splits
    else delete state.splits
  })
}

export async function flushOpenProjectSessions(): Promise<void> {
  await mutationQueue
}
