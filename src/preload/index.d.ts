interface SessionMeta {
  path: string
  id: string
  cwd: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
}

interface ProjectGroup {
  cwd: string
  name: string
  sessions: SessionMeta[]
}

interface SessionModelInfo {
  id: string
  name: string
  provider: string
  contextWindow: number
  reasoning: boolean
}

interface SessionContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

interface SessionTokenStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

interface SessionControls {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  contextUsage: SessionContextUsage | null
  tokens: SessionTokenStats
}

declare global {
  interface Window {
    api: {
      listProjects: () => Promise<ProjectGroup[]>
      listProject: (cwd: string) => Promise<ProjectGroup | null>
      createSession: (cwd: string) => Promise<{ sessionId: string; cwd: string }>
      openSession: (path: string) => Promise<{ sessionId: string; cwd: string }>
      prepareSession: (sessionId: string) => Promise<{ sessionId: string; cwd: string; created: boolean }>
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
  }
}

export {}