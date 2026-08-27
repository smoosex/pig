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

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface SessionControls {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  contextUsage: SessionContextUsage | null
  tokens: SessionTokenStats
}

interface SessionTreeGutter {
  position: number
  show: boolean
}

interface DisplayUser {
  text: string
  images: { mimeType: string; data: string }[]
}

interface DisplayTurn {
  id: string
  user?: DisplayUser
  answer: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>
  errorMessage?: string
  startedAt: number
  endedAt: number
  hasProcess: boolean
}

interface SessionTreeRow {
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
      getDisplayTurns: (sessionId: string) => Promise<DisplayTurn[]>
      getTurnMessages: (sessionId: string, turnId: string) => Promise<unknown[]>
      getSessionTree: (sessionId: string) => Promise<SessionTreeRow[]>
      viewBranch: (sessionId: string, tipId: string) => Promise<void>
      getControls: (sessionId: string) => Promise<SessionControls>
      setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
      setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
      pickDirectory: () => Promise<string | null>
      onEvent: (listener: (event: unknown) => void) => () => void
    }
  }
}

export {}