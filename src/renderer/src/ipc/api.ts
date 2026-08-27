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

export interface SessionRef {
  sessionId: string
  cwd: string
  created?: boolean
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface SessionModelInfo {
  id: string
  name: string
  provider: string
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

export type PiEvent = {
  type: string
  [key: string]: unknown
}

export interface SessionApi {
  listProjects: () => Promise<ProjectGroup[]>
  listProject: (cwd: string) => Promise<ProjectGroup | null>
  prepareSession: (sessionId: string) => Promise<SessionRef>
  createSession: (cwd: string) => Promise<SessionRef>
  openSession: (path: string) => Promise<SessionRef>
  closeSession: (sessionId: string) => Promise<void>
  deleteProject: (cwd: string) => Promise<void>
  deleteSession: (sessionId: string, path: string, cwd: string) => Promise<void>
  prompt: (sessionId: string, text: string) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  getMessages: (sessionId: string) => Promise<unknown[]>
  getControls: (sessionId: string) => Promise<SessionControls>
  setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
  setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
  pickDirectory: () => Promise<string | null>
  onEvent: (listener: (event: unknown) => void) => () => void
}

export const api: SessionApi = window.api