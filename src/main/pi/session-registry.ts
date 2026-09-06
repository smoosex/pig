import { writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession
} from '@earendil-works/pi-coding-agent'
import { isChatCwd } from '../chats'
import { createChatResourceLoader } from './chat-resources'
import { bridgeEvents } from './event-bridge'

export type SessionThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export interface SessionModelInfo {
  id: string
  name: string
  provider: string
  providerName: string
  contextWindow: number
  reasoning: boolean
}

export interface SessionContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface SessionTokenStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface SessionControls {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  thinkingLevel: SessionThinkingLevel
  thinkingLevels: SessionThinkingLevel[]
  contextUsage: SessionContextUsage | null
  tokens: SessionTokenStats
}

export interface SessionTreeGutter {
  position: number
  show: boolean
}

export interface SessionTreeRow {
  id: string
  parentId: string | null
  indent: number
  gutters: SessionTreeGutter[]
  showConnector: boolean
  isLast: boolean
  isVirtualRootChild: boolean
  foldable: boolean
  onPath: boolean
  current: boolean
  kind: 'user' | 'assistant' | 'tool' | 'other'
  text: string
}

const emptyTokens: SessionTokenStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0
}

const THINKING_LEVELS: SessionThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

const HIDDEN_THINKING_LEVELS = new Set<SessionThinkingLevel>(['off', 'minimal'])

export interface LiveSession {
  sessionId: string
  cwd: string
  agentSession: AgentSession
  unsubscribe: () => void
}

export interface PendingSession {
  sessionId: string
  cwd: string
  sessionManager: SessionManager
  win: BrowserWindow
  modelProvider?: string
  modelId?: string
  thinkingLevel?: SessionThinkingLevel
}

const live = new Map<string, LiveSession>()
const pending = new Map<string, PendingSession>()
const preparing = new Map<string, Promise<LiveSession>>()

let modelRuntime: ModelRuntime | undefined
let modelRuntimePromise: Promise<ModelRuntime> | undefined
let settingsManager: SettingsManager | undefined

export function startModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create().then((runtime) => {
      modelRuntime = runtime
      void runtime.refresh()
      return runtime
    })
  }
  return modelRuntimePromise
}

async function build(
  sessionManager: SessionManager,
  cwd: string,
  win: BrowserWindow
): Promise<LiveSession> {
  const resourceLoader = isChatCwd(cwd) ? await createChatResourceLoader(cwd) : undefined
  const result = await createAgentSession({
    cwd,
    sessionManager,
    modelRuntime: await startModelRuntime(),
    ...(resourceLoader ? { resourceLoader } : {})
  })
  const session = result.session
  await session.bindExtensions({ mode: 'rpc' })
  const unsubscribe = bridgeEvents(session, session.sessionId, win)
  const ls: LiveSession = { sessionId: session.sessionId, cwd, agentSession: session, unsubscribe }
  live.set(session.sessionId, ls)
  return ls
}

export function createPendingSession(cwd: string, win: BrowserWindow): PendingSession {
  const sessionManager = SessionManager.create(cwd)
  const sessionId = sessionManager.getSessionId()
  const session = { sessionId, cwd, sessionManager, win }
  pending.set(sessionId, session)
  return session
}

async function materialize(session: PendingSession): Promise<LiveSession> {
  const sessionFile = session.sessionManager.getSessionFile()
  const header = session.sessionManager.getHeader()
  if (!sessionFile || !header) throw new Error('Pending session has no session file or header')

  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx' })
  session.sessionManager.setSessionFile(sessionFile)

  try {
    const liveSession = await build(session.sessionManager, session.cwd, session.win)
    await applyPendingControls(session, liveSession)
    pending.delete(session.sessionId)
    return liveSession
  } catch (error) {
    await rm(sessionFile, { force: true })
    throw error
  }
}

async function applyPendingControls(
  session: PendingSession,
  liveSession: LiveSession
): Promise<void> {
  if (session.modelProvider && session.modelId) {
    const model = (await startModelRuntime()).getModel(session.modelProvider, session.modelId)
    if (model) await liveSession.agentSession.setModel(model)
  }
  if (session.thinkingLevel) {
    liveSession.agentSession.setThinkingLevel(session.thinkingLevel)
  }
}

function toModelInfo(model: {
  id: string
  name: string
  provider: string
  contextWindow: number
  reasoning: boolean
}): SessionModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    providerName: modelRuntime?.getProvider(model.provider)?.name ?? model.provider,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning
  }
}

function availableModels(): SessionModelInfo[] {
  return (modelRuntime?.getAvailableSnapshot() ?? []).map(toModelInfo)
}

function thinkingLevelsFor(model: { provider: string; id: string } | null): SessionThinkingLevel[] {
  if (!model) return ['off']
  const full = modelRuntime?.getModel(model.provider, model.id)
  if (!full?.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = full.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

function clampThinking(
  level: SessionThinkingLevel | undefined,
  levels: SessionThinkingLevel[]
): SessionThinkingLevel {
  if (level && levels.includes(level)) return level
  return levels[0] ?? 'off'
}

function pickerThinkingLevels(levels: SessionThinkingLevel[]): SessionThinkingLevel[] {
  return levels.filter((level) => !HIDDEN_THINKING_LEVELS.has(level))
}

function findModel(provider: string, id: string): SessionModelInfo | null {
  const model = modelRuntime?.getModel(provider, id)
  return model ? toModelInfo(model) : null
}

function appSettings(): SettingsManager {
  settingsManager ??= SettingsManager.create(process.cwd())
  return settingsManager
}

function defaultModelFromSettings(): SessionModelInfo | null {
  const settings = appSettings()
  const provider = settings.getDefaultProvider()
  const id = settings.getDefaultModel()
  if (!provider || !id) return null
  return findModel(provider, id)
}

export async function listAvailableModels(): Promise<SessionModelInfo[]> {
  await startModelRuntime()
  return availableModels()
}

export interface DefaultSessionSettings {
  model: SessionModelInfo | null
  thinkingLevel: SessionThinkingLevel | null
  thinkingLevels: SessionThinkingLevel[]
}

function defaultThinkingFromSettings(
  model: { provider: string; id: string } | null
): SessionThinkingLevel | undefined {
  const settings = appSettings()
  if (model) {
    const perModel = settings.getModelThinkingLevel(model.provider, model.id)
    if (perModel) return perModel as SessionThinkingLevel
  }
  const global = settings.getDefaultThinkingLevel()
  return global as SessionThinkingLevel | undefined
}

function defaultSessionSettings(model: SessionModelInfo | null): DefaultSessionSettings {
  const picker = pickerThinkingLevels(thinkingLevelsFor(model))
  const stored = defaultThinkingFromSettings(model)
  const thinkingLevel =
    stored && picker.includes(stored) ? stored : (picker[0] ?? null)
  return { model, thinkingLevel, thinkingLevels: picker }
}

function persistDefaultThinking(
  model: SessionModelInfo | null,
  level: SessionThinkingLevel | null
): void {
  if (!level) return
  const settings = appSettings()
  settings.setDefaultThinkingLevel(level)
  if (model) settings.setModelThinkingLevel(model.provider, model.id, level)
}

export async function getDefaultSessionSettings(): Promise<DefaultSessionSettings> {
  await startModelRuntime()
  await appSettings().reload()
  return defaultSessionSettings(defaultModelFromSettings() ?? availableModels()[0] ?? null)
}

export async function setDefaultModel(provider: string, id: string): Promise<DefaultSessionSettings> {
  await startModelRuntime()
  const model = findModel(provider, id)
  if (!model) throw new Error(`Model not found: ${provider}/${id}`)
  const settings = appSettings()
  settings.setDefaultModelAndProvider(provider, id)
  const next = defaultSessionSettings(model)
  persistDefaultThinking(next.model, next.thinkingLevel)
  await settings.flush()
  return next
}

export async function setDefaultThinking(level: SessionThinkingLevel): Promise<DefaultSessionSettings> {
  await startModelRuntime()
  if (!THINKING_LEVELS.includes(level) || HIDDEN_THINKING_LEVELS.has(level)) {
    throw new Error(`Invalid thinking level: ${level}`)
  }
  const model = defaultModelFromSettings() ?? availableModels()[0] ?? null
  const picker = pickerThinkingLevels(thinkingLevelsFor(model))
  if (!picker.includes(level)) throw new Error(`Thinking level not supported: ${level}`)
  persistDefaultThinking(model, level)
  await appSettings().flush()
  return { model, thinkingLevel: level, thinkingLevels: picker }
}

function tokenStatsFromEntries(sessionManager: SessionManager): SessionTokenStats {
  const tokens = { ...emptyTokens }
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    const usage = entry.message.usage
    tokens.input += usage.input
    tokens.output += usage.output
    tokens.cacheRead += usage.cacheRead
    tokens.cacheWrite += usage.cacheWrite
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  return tokens
}

export async function getSessionControls(sessionId: string): Promise<SessionControls> {
  await startModelRuntime()
  const models = availableModels()
  const liveSession = live.get(sessionId)
  if (liveSession) {
    const model = liveSession.agentSession.model
      ? toModelInfo(liveSession.agentSession.model)
      : null
    const usage = liveSession.agentSession.getContextUsage()
    return {
      model,
      models,
      thinkingLevel: liveSession.agentSession.thinkingLevel,
      thinkingLevels: pickerThinkingLevels(
        liveSession.agentSession.getAvailableThinkingLevels() as SessionThinkingLevel[]
      ),
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent
          }
        : null,
      tokens: tokenStatsFromEntries(liveSession.agentSession.sessionManager)
    }
  }

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  const model =
    session.modelProvider && session.modelId
      ? findModel(session.modelProvider, session.modelId)
      : (defaultModelFromSettings() ?? models[0] ?? null)
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  return {
    model,
    models,
    thinkingLevel: clampThinking(
      session.thinkingLevel ?? defaultThinkingFromSettings(model),
      picker.length > 0 ? picker : supported
    ),
    thinkingLevels: picker,
    contextUsage: null,
    tokens: tokenStatsFromEntries(session.sessionManager)
  }
}

export async function setSessionModel(
  sessionId: string,
  provider: string,
  id: string
): Promise<SessionControls> {
  const model = (await startModelRuntime()).getModel(provider, id)
  if (!model) throw new Error(`Model not found: ${provider}/${id}`)

  const liveSession = live.get(sessionId)
  if (liveSession) {
    await liveSession.agentSession.setModel(model)
    return getSessionControls(sessionId)
  }

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  session.modelProvider = provider
  session.modelId = id
  session.thinkingLevel = clampThinking(session.thinkingLevel, thinkingLevelsFor({ provider, id }))
  return getSessionControls(sessionId)
}

export async function setSessionThinking(
  sessionId: string,
  level: SessionThinkingLevel
): Promise<SessionControls> {
  if (!THINKING_LEVELS.includes(level) || HIDDEN_THINKING_LEVELS.has(level)) {
    throw new Error(`Invalid thinking level: ${level}`)
  }

  const liveSession = live.get(sessionId)
  if (liveSession) {
    liveSession.agentSession.setThinkingLevel(level)
    return getSessionControls(sessionId)
  }

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  const model =
    session.modelProvider && session.modelId
      ? { provider: session.modelProvider, id: session.modelId }
      : (defaultModelFromSettings() ?? availableModels()[0] ?? null)
  const levels = pickerThinkingLevels(thinkingLevelsFor(model))
  if (!levels.includes(level)) throw new Error(`Thinking level not supported: ${level}`)
  session.thinkingLevel = level
  return getSessionControls(sessionId)
}

export async function refreshSessionModels(sessionId: string): Promise<SessionControls> {
  await (await startModelRuntime()).refresh()
  return getSessionControls(sessionId)
}

export function prepareSession(sessionId: string): Promise<LiveSession> {
  const existing = live.get(sessionId)
  if (existing) return Promise.resolve(existing)

  const running = preparing.get(sessionId)
  if (running) return running

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const promise = materialize(session).finally(() => {
    preparing.delete(sessionId)
  })
  preparing.set(sessionId, promise)
  return promise
}

export async function openSession(path: string, win: BrowserWindow): Promise<LiveSession> {
  for (const ls of live.values()) {
    if (ls.agentSession.sessionFile === path) return ls
  }
  const sm = SessionManager.open(path)
  const cwd = sm.getCwd() || process.cwd()
  return build(sm, cwd, win)
}

export function getLive(sessionId: string): LiveSession | undefined {
  return live.get(sessionId)
}

export type SessionSlashSource = 'builtin' | 'extension' | 'prompt' | 'skill'

export interface SessionSlashCommand {
  name: string
  description?: string
  source: SessionSlashSource
}

const BUILTIN_SLASH_COMMANDS: SessionSlashCommand[] = [
  { name: 'export', description: '导出会话为 HTML 或 JSONL', source: 'builtin' }
]

export async function listSessionCommands(sessionId: string): Promise<SessionSlashCommand[]> {
  const ls = getLive(sessionId) ?? (await prepareSession(sessionId))
  const session = ls.agentSession
  const taken = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name))
  const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description,
    source: 'extension' as const
  }))
  const templates = session.promptTemplates.map((template) => ({
    name: template.name,
    description: template.description,
    source: 'prompt' as const
  }))
  const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: 'skill' as const
  }))
  return [
    ...BUILTIN_SLASH_COMMANDS,
    ...[...extensionCommands, ...templates, ...skills].filter((command) => !taken.has(command.name))
  ]
}

export async function exportSession(sessionId: string, outputPath?: string): Promise<string> {
  const ls = getLive(sessionId) ?? (await prepareSession(sessionId))
  const target = outputPath?.trim()
  if (target?.endsWith('.jsonl')) return ls.agentSession.exportToJsonl(target)
  return ls.agentSession.exportToHtml(target)
}

type TreeNode = {
  entry: {
    id: string
    type: string
    summary?: string
    tokensBefore?: number
    customType?: string
    modelId?: string
    thinkingLevel?: string
    name?: string
    message?: {
      role?: string
      content?: unknown
      command?: string
      toolCallId?: string
      toolName?: string
      stopReason?: string
      errorMessage?: string
    }
  }
  children: TreeNode[]
}

function isHiddenEntry(type: string): boolean {
  return (
    type === 'label' ||
    type === 'custom' ||
    type === 'model_change' ||
    type === 'thinking_level_change' ||
    type === 'session_info'
  )
}

function oneLine(value: string, max = 120): string {
  return value.replace(/[\n\t]/g, ' ').trim().slice(0, max)
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return oneLine(content)
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    if (text.length >= 120) break
  }
  return oneLine(text)
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      return true
    }
  }
  return false
}

function hideInDefaultView(entry: TreeNode['entry'], current: boolean): boolean {
  if (isHiddenEntry(entry.type)) return true
  if (entry.type !== 'message' || entry.message?.role !== 'assistant' || current) return false
  const stop = entry.message.stopReason
  const isErrorOrAborted = Boolean(stop && stop !== 'stop' && stop !== 'toolUse')
  return !hasTextContent(entry.message.content) && !isErrorOrAborted && !entry.message.errorMessage
}

function shortenPath(path: string): string {
  const home = homedir()
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function scalarPreview(args: Record<string, unknown>, max = 40): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    parts.push(`${key}:${String(value)}`)
    if (parts.join(', ').length >= max) break
  }
  return oneLine(parts.join(', '), max)
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read':
      return `[read: ${shortenPath(String(args.path || args.file_path || ''))}]`
    case 'write':
      return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`
    case 'edit':
      return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`
    case 'bash': {
      const raw = String(args.command || '')
      const cmd = oneLine(raw, 50)
      return `[bash: ${cmd}${raw.length > 50 ? '...' : ''}]`
    }
    case 'ls':
      return `[ls: ${shortenPath(String(args.path || '.'))}]`
    case 'grep':
    case 'ffgrep':
      return `[${name}: ${oneLine(String(args.pattern || scalarPreview(args)), 40)}]`
    case 'find':
    case 'fffind':
      return `[${name}: ${oneLine(String(args.pattern || ''), 40)}]`
    default:
      return `[${name}: ${scalarPreview(args)}]`
  }
}

function collectToolCalls(entry: TreeNode['entry'], toolCalls: Map<string, { name: string; arguments: Record<string, unknown> }>): void {
  if (entry.type !== 'message' || entry.message?.role !== 'assistant') return
  const content = entry.message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type === 'toolCall' && typeof block.id === 'string') {
      toolCalls.set(block.id, {
        name: String(block.name ?? 'tool'),
        arguments: (block.arguments ?? {}) as Record<string, unknown>
      })
    }
  }
}

function kindOf(entry: TreeNode['entry']): SessionTreeRow['kind'] {
  const role = entry.message?.role
  if (entry.type === 'message' && role === 'user') return 'user'
  if (entry.type === 'message' && role === 'assistant') return 'assistant'
  if (entry.type === 'message' && (role === 'toolResult' || role === 'bashExecution')) return 'tool'
  return 'other'
}

function labelOf(
  entry: TreeNode['entry'],
  toolCalls: Map<string, { name: string; arguments: Record<string, unknown> }>
): string {
  if (entry.type === 'message') {
    const role = entry.message?.role
    if (role === 'user') return `user: ${extractContent(entry.message?.content)}`
    if (role === 'assistant') {
      const text = extractContent(entry.message?.content)
      if (text) return `assistant: ${text}`
      if (entry.message?.stopReason === 'aborted') return 'assistant: (aborted)'
      if (entry.message?.errorMessage) return `assistant: ${oneLine(entry.message.errorMessage, 80)}`
      return 'assistant: (no content)'
    }
    if (role === 'toolResult') {
      const call = entry.message?.toolCallId ? toolCalls.get(entry.message.toolCallId) : undefined
      return call ? formatToolCall(call.name, call.arguments) : `[${entry.message?.toolName ?? 'tool'}]`
    }
    if (role === 'bashExecution') return `[bash]: ${oneLine(entry.message?.command ?? '')}`
    return `[${role ?? 'message'}]`
  }
  if (entry.type === 'custom_message') return `[${entry.customType ?? 'custom'}]: ${extractContent(entry.message?.content)}`
  if (entry.type === 'compaction') {
    const tokens = Math.round((entry.tokensBefore ?? 0) / 1000)
    return `[compaction: ${tokens}k tokens]`
  }
  if (entry.type === 'branch_summary') return `[branch summary]: ${oneLine(entry.summary ?? '')}`
  return `[${entry.type}]`
}

type VisibleNode = {
  id: string
  parentId: string | null
  kind: SessionTreeRow['kind']
  text: string
  onPath: boolean
  current: boolean
  indent: number
  gutters: SessionTreeGutter[]
  showConnector: boolean
  isLast: boolean
  isVirtualRootChild: boolean
  foldable: boolean
}

function containsActiveMap(roots: TreeNode[], leafId: string | null): Map<string, boolean> {
  const containsActive = new Map<string, boolean>()
  const all: TreeNode[] = []
  const pre = [...roots]
  while (pre.length > 0) {
    const node = pre.pop()!
    all.push(node)
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i--) pre.push(children[i])
  }
  for (let i = all.length - 1; i >= 0; i--) {
    const node = all[i]
    let has = leafId !== null && node.entry.id === leafId
    for (const child of node.children ?? []) {
      if (containsActive.get(child.entry.id)) has = true
    }
    containsActive.set(node.entry.id, has)
  }
  return containsActive
}

function prioritizeActive(children: TreeNode[], containsActive: Map<string, boolean>): TreeNode[] {
  const onPath: TreeNode[] = []
  const rest: TreeNode[] = []
  for (const child of children) {
    if (containsActive.get(child.entry.id)) onPath.push(child)
    else rest.push(child)
  }
  return onPath.length ? [...onPath, ...rest] : children
}

function collectVisible(
  roots: TreeNode[],
  leafId: string | null,
  pathSet: Set<string>
): { visible: VisibleNode[]; parentOf: Map<string, string | null> } {
  const containsActive = containsActiveMap(roots, leafId)
  const parentOf = new Map<string, string | null>()
  const visible: VisibleNode[] = []
  const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>()
  const stack: { node: TreeNode; parentId: string | null }[] = []
  const orderedRoots = prioritizeActive(roots, containsActive)
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    stack.push({ node: orderedRoots[i], parentId: null })
  }

  while (stack.length > 0) {
    const { node, parentId } = stack.pop()!
    collectToolCalls(node.entry, toolCalls)
    parentOf.set(node.entry.id, parentId)
    const current = node.entry.id === leafId
    if (!hideInDefaultView(node.entry, current)) {
      visible.push({
        id: node.entry.id,
        parentId,
        kind: kindOf(node.entry),
        text: labelOf(node.entry, toolCalls),
        onPath: pathSet.has(node.entry.id),
        current,
        indent: 0,
        gutters: [],
        showConnector: false,
        isLast: true,
        isVirtualRootChild: false,
        foldable: false
      })
    }
    const children = prioritizeActive(node.children ?? [], containsActive)
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentId: node.entry.id })
    }
  }
  return { visible, parentOf }
}

function layoutVisible(visible: VisibleNode[], parentOf: Map<string, string | null>): void {
  if (visible.length === 0) return
  const visibleIds = new Set(visible.map((node) => node.id))
  const byId = new Map(visible.map((node) => [node.id, node]))
  const visibleParent = new Map<string, string | null>()
  const visibleChildren = new Map<string | null, string[]>()
  visibleChildren.set(null, [])

  const findVisibleAncestor = (id: string): string | null => {
    let currentId = parentOf.get(id) ?? null
    while (currentId) {
      if (visibleIds.has(currentId)) return currentId
      currentId = parentOf.get(currentId) ?? null
    }
    return null
  }

  for (const node of visible) {
    const ancestorId = findVisibleAncestor(node.id)
    visibleParent.set(node.id, ancestorId)
    node.parentId = ancestorId
    const list = visibleChildren.get(ancestorId) ?? []
    list.push(node.id)
    visibleChildren.set(ancestorId, list)
  }

  const rootIds = visibleChildren.get(null) ?? []
  const multipleRoots = rootIds.length > 1
  const stack: {
    id: string
    indent: number
    justBranched: boolean
    showConnector: boolean
    isLast: boolean
    gutters: SessionTreeGutter[]
    isVirtualRootChild: boolean
  }[] = []
  for (let i = rootIds.length - 1; i >= 0; i--) {
    stack.push({
      id: rootIds[i],
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      showConnector: multipleRoots,
      isLast: i === rootIds.length - 1,
      gutters: [],
      isVirtualRootChild: multipleRoots
    })
  }

  while (stack.length > 0) {
    const frame = stack.pop()!
    const node = byId.get(frame.id)
    if (!node) continue
    node.indent = frame.indent
    node.showConnector = frame.showConnector
    node.isLast = frame.isLast
    node.gutters = frame.gutters
    node.isVirtualRootChild = frame.isVirtualRootChild
    const children = visibleChildren.get(frame.id) ?? []
    const multipleChildren = children.length > 1
    const parentId = visibleParent.get(frame.id)
    node.foldable =
      children.length > 0 &&
      (parentId == null || (visibleChildren.get(parentId)?.length ?? 0) > 1)
    let childIndent = frame.indent
    if (multipleChildren) childIndent = frame.indent + 1
    else if (frame.justBranched && frame.indent > 0) childIndent = frame.indent + 1
    const connectorDisplayed = frame.showConnector && !frame.isVirtualRootChild
    const currentDisplayIndent = multipleRoots ? Math.max(0, frame.indent - 1) : frame.indent
    const connectorPosition = Math.max(0, currentDisplayIndent - 1)
    const childGutters = connectorDisplayed
      ? [...frame.gutters, { position: connectorPosition, show: !frame.isLast }]
      : frame.gutters
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({
        id: children[i],
        indent: childIndent,
        justBranched: multipleChildren,
        showConnector: multipleChildren,
        isLast: i === children.length - 1,
        gutters: childGutters,
        isVirtualRootChild: false
      })
    }
  }
}

export function sessionManagerFor(sessionId: string): SessionManager {
  const liveSession = live.get(sessionId)
  if (liveSession) return liveSession.agentSession.sessionManager
  const pendingSession = pending.get(sessionId)
  if (pendingSession) return pendingSession.sessionManager
  throw new Error(`Session not found: ${sessionId}`)
}

export function getSessionTree(sessionId: string): SessionTreeRow[] {
  const sm = sessionManagerFor(sessionId)
  const leafId = sm.getLeafId()
  const pathSet = new Set(sm.getBranch().map((entry) => entry.id))
  const { visible, parentOf } = collectVisible(sm.getTree() as TreeNode[], leafId, pathSet)
  layoutVisible(visible, parentOf)
  return visible.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    indent: node.indent,
    gutters: node.gutters,
    showConnector: node.showConnector,
    isLast: node.isLast,
    isVirtualRootChild: node.isVirtualRootChild,
    foldable: node.foldable,
    onPath: node.onPath,
    current: node.current,
    kind: node.kind,
    text: node.text
  }))
}

export function viewSessionBranch(sessionId: string, tipId: string): void {
  const ls = getLive(sessionId)
  if (!ls) throw new Error(`Session not found: ${sessionId}`)
  if (ls.agentSession.isStreaming) throw new Error('Session is streaming')
  const sm = ls.agentSession.sessionManager
  if (!sm.getEntry(tipId)) throw new Error(`Entry not found: ${tipId}`)
  if (sm.getLeafId() === tipId) return
  sm.branch(tipId)
  ls.agentSession.agent.state.messages = sm.buildSessionContext().messages
}

async function disposeLiveSession(session: LiveSession): Promise<void> {
  session.unsubscribe()
  try {
    await session.agentSession.abort()
  } catch {
  }
  try {
    await session.agentSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch {
  }
  session.agentSession.dispose()
}

export async function closeSession(sessionId: string): Promise<void> {
  const preparation = preparing.get(sessionId)
  if (preparation) {
    pending.delete(sessionId)
    try {
      const prepared = await preparation
      if (live.get(sessionId) === prepared) {
        live.delete(sessionId)
        await disposeLiveSession(prepared)
      }
    } catch {
    }
    return
  }

  if (pending.delete(sessionId)) return
  const ls = live.get(sessionId)
  if (!ls) return
  live.delete(sessionId)
  await disposeLiveSession(ls)
}

export async function closeSessionsForCwd(cwd: string): Promise<void> {
  const target = resolve(cwd)
  const sessionIds = new Set([
    ...[...pending.values()]
      .filter((session) => resolve(session.cwd) === target)
      .map((session) => session.sessionId),
    ...[...live.values()]
      .filter((session) => resolve(session.cwd) === target)
      .map((session) => session.sessionId)
  ])
  await Promise.all([...sessionIds].map((sessionId) => closeSession(sessionId)))
}

export async function disposeAll(): Promise<void> {
  const preparations = [...preparing.values()]
  pending.clear()
  preparing.clear()
  const sessions = [...live.values()]
  live.clear()
  const disposed = new Set(sessions)
  await Promise.all([
    ...sessions.map(disposeLiveSession),
    ...preparations.map(async (preparation) => {
      try {
        const session = await preparation
        if (disposed.has(session)) return
        disposed.add(session)
        live.delete(session.sessionId)
        await disposeLiveSession(session)
      } catch {
      }
    })
  ])
}
