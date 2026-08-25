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
}

export type PiEvent = {
  type: string
  [key: string]: unknown
}

export interface SessionApi {
  listProjects: () => Promise<ProjectGroup[]>
  createSession: (cwd: string) => Promise<SessionRef>
  openSession: (path: string) => Promise<SessionRef>
  closeSession: (sessionId: string) => Promise<void>
  deleteProject: (cwd: string) => Promise<void>
  prompt: (sessionId: string, text: string) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  getMessages: (sessionId: string) => Promise<unknown[]>
  pickDirectory: () => Promise<string | null>
  onEvent: (listener: (event: unknown) => void) => () => void
}

export const api: SessionApi = window.api