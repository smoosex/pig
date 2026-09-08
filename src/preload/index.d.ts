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

interface WorktreeGroup {
  cwd: string
  branch: string
  head?: string
  isPrimary: boolean
  locked: boolean
  missing: boolean
  managed: boolean
  naming?: 'pending' | 'naming' | 'failed'
  namingError?: string
  sessions: SessionMeta[]
}

interface ProjectGroup {
  cwd: string
  name: string
  sessions: SessionMeta[]
  worktrees?: WorktreeGroup[]
  hasGit?: boolean
  gitError?: string
}

interface SidebarPrefs {
  projectsCollapsed: boolean
  chatsCollapsed: boolean
  split: number
}

interface SessionModelInfo {
  id: string
  name: string
  provider: string
  providerName: string
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

type SlashCommandSource = 'builtin' | 'extension' | 'prompt' | 'skill'

interface SlashCommand {
  name: string
  description?: string
  source: SlashCommandSource
}

interface SessionTreeGutter {
  position: number
  show: boolean
}

interface PastedTextAttachmentInput {
  id: string
  text: string
}

interface PastedTextAttachment {
  id: string
  text: string
  byteSize: number
}

interface DisplayUser {
  text: string
  images: { mimeType: string; data: string }[]
  textAttachments: PastedTextAttachment[]
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

interface DisplayTurnsResult {
  leafId: string | null
  turns: DisplayTurn[]
}

interface SessionBranchRef {
  leafId: string | null
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
      listChats: () => Promise<ProjectGroup[]>
      isChatCwd: (cwd: string) => Promise<boolean>
      openProject: () => Promise<ProjectGroup | null>
      unpinProject: (cwd: string) => Promise<void>
      reorderProjects: (cwds: string[]) => Promise<string[]>
      createChat: () => Promise<{ sessionId: string; cwd: string }>
      deleteChat: (cwd: string) => Promise<void>
      createSession: (cwd: string) => Promise<{ sessionId: string; cwd: string }>
      openSession: (path: string) => Promise<{ sessionId: string; cwd: string }>
      prepareSession: (sessionId: string) => Promise<{ sessionId: string; cwd: string; created: boolean }>
      closeSession: (sessionId: string) => Promise<void>
      deleteProject: (cwd: string) => Promise<boolean>
      worktreeCreateInfo: (projectCwd: string) => Promise<{ hasGit: boolean; hasHead: boolean }>
      createWorktree: (projectCwd: string, options?: { initGit?: boolean }) => Promise<{ cwd: string; project: ProjectGroup } | null>
      worktreeDeletionInfo: (projectCwd: string, cwd: string) => Promise<{
        cwd: string
        branch: string
        dirty: boolean
        unmerged: boolean
        missing: boolean
      }>
      deleteWorktree: (projectCwd: string, cwd: string, force?: boolean) => Promise<{ cwd: string; project: ProjectGroup } | null>
      onProjectsChanged: (listener: (projectCwd: string) => void) => () => void
      deleteSession: (sessionId: string, path: string, cwd: string) => Promise<void>
      prompt: (
        sessionId: string,
        text: string,
        images?: { mimeType: string; data: string }[],
        textAttachments?: PastedTextAttachmentInput[]
      ) => Promise<void>
      abort: (sessionId: string) => Promise<void>
      getMessages: (sessionId: string) => Promise<unknown[]>
      getDisplayTurns: (sessionId: string) => Promise<DisplayTurnsResult>
      getTurnMessages: (sessionId: string, turnId: string) => Promise<unknown[]>
      getSessionTree: (sessionId: string) => Promise<SessionTreeRow[]>
      viewBranch: (sessionId: string, tipId: string) => Promise<SessionBranchRef>
      getControls: (sessionId: string) => Promise<SessionControls>
      getCommands: (sessionId: string) => Promise<SlashCommand[]>
      exportSession: (sessionId: string, outputPath?: string) => Promise<{ path: string } | null>
      setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
      setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
      refreshModels: (sessionId: string) => Promise<SessionControls>
      pickDirectory: () => Promise<string | null>
      getSidebarPrefs: () => Promise<SidebarPrefs>
      setSidebarPrefs: (patch: Partial<SidebarPrefs>) => Promise<SidebarPrefs>
      getSettings: () => Promise<unknown>
      setSendShortcut: (shortcut: string) => Promise<unknown>
      setTheme: (patch: unknown) => Promise<unknown>
      setDefaultModelSetting: (provider: string, id: string) => Promise<unknown>
      setDefaultThinkingSetting: (level: string) => Promise<unknown>
      listProviders: () => Promise<unknown>
      loginProvider: (providerId: string, authType: string) => Promise<unknown>
      logoutProvider: (providerId: string) => Promise<unknown>
      replyAuthPrompt: (id: string, value: string | null) => Promise<void>
      cancelLogin: () => Promise<void>
      onEvent: (listener: (event: unknown) => void) => () => void
      onAuthEvent: (listener: (event: unknown) => void) => () => void
    }
  }
}

export {}