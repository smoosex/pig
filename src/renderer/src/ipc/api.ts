export interface SessionMeta {
  path: string
  id: string
  cwd: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
}

export interface ProjectGroup {
  cwd: string
  name: string
  sessions: SessionMeta[]
}

export interface SidebarPrefs {
  projectsCollapsed: boolean
  chatsCollapsed: boolean
  split: number
}

export interface SessionRef {
  sessionId: string
  cwd: string
  created?: boolean
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  contextUsage: SessionContextUsage | null
  tokens: SessionTokenStats
}

export interface DisplayUser {
  text: string
  images: { mimeType: string; data: string }[]
}

export type DisplayAnswer =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export interface DisplayTurn {
  id: string
  user?: DisplayUser
  answer: DisplayAnswer[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  hasProcess: boolean
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

export type PiEvent = {
  type: string
  [key: string]: unknown
}

export interface SessionApi {
  listProjects: () => Promise<ProjectGroup[]>
  listProject: (cwd: string) => Promise<ProjectGroup | null>
  listChats: () => Promise<ProjectGroup[]>
  isChatCwd: (cwd: string) => Promise<boolean>
  openProject: () => Promise<ProjectGroup | null>
  unpinProject: (cwd: string) => Promise<void>
  prepareSession: (sessionId: string) => Promise<SessionRef>
  createSession: (cwd: string) => Promise<SessionRef>
  createChat: () => Promise<SessionRef>
  deleteChat: (cwd: string) => Promise<void>
  openSession: (path: string) => Promise<SessionRef>
  closeSession: (sessionId: string) => Promise<void>
  deleteProject: (cwd: string) => Promise<void>
  deleteSession: (sessionId: string, path: string, cwd: string) => Promise<void>
  prompt: (sessionId: string, text: string) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  getMessages: (sessionId: string) => Promise<unknown[]>
  getDisplayTurns: (sessionId: string) => Promise<DisplayTurn[]>
  getTurnMessages: (sessionId: string, turnId: string) => Promise<unknown[]>
  getSessionTree: (sessionId: string) => Promise<SessionTreeRow[]>
  viewBranch: (sessionId: string, tipId: string) => Promise<void>
  getControls: (sessionId: string) => Promise<SessionControls>
  setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
  setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
  refreshModels: (sessionId: string) => Promise<SessionControls>
  pickDirectory: () => Promise<string | null>
  getSidebarPrefs: () => Promise<SidebarPrefs>
  setSidebarPrefs: (patch: Partial<SidebarPrefs>) => Promise<SidebarPrefs>
  onEvent: (listener: (event: unknown) => void) => () => void
}

export const api: SessionApi = window.api