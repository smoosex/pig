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

declare global {
  interface Window {
    api: {
      listProjects: () => Promise<ProjectGroup[]>
      createSession: (cwd: string) => Promise<{ sessionId: string; cwd: string }>
      openSession: (path: string) => Promise<{ sessionId: string; cwd: string }>
      closeSession: (sessionId: string) => Promise<void>
      deleteProject: (cwd: string) => Promise<void>
      prompt: (sessionId: string, text: string) => Promise<void>
      abort: (sessionId: string) => Promise<void>
      getMessages: (sessionId: string) => Promise<unknown[]>
      pickDirectory: () => Promise<string | null>
      onEvent: (listener: (event: unknown) => void) => () => void
    }
  }
}

export {}