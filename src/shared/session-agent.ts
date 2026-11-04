/** Contracts for controlling ordinary Pig sessions; these sessions are visible, independent tabs. */
import type { ProjectGroup, SessionControls, SessionRef, ThinkingLevel, TurnUsage } from './api'
import type { CapabilityGroup, SessionCapabilities } from './session-capabilities'

export interface SessionCapabilityPatch {
  group: CapabilityGroup
  /** null applies to the entire group, including plugin tool groups. */
  id: string | null
  enabled: boolean | null
}
export interface SessionAgentConfig {
  model?: { provider: string; id: string }
  thinking?: ThinkingLevel
  capabilities?: SessionCapabilityPatch[]
}
export interface SessionAgentCreate extends SessionAgentConfig {
  cwd: string
  title?: string
}
export interface SessionAgentTask {
  taskId: string
  sessionId: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  blockedBy?: 'approval'
  startedAt: number
  endedAt?: number
  durationMs: number
  reply: string
  error?: string
  /** Observable message usage only, including all child transcripts created during this task. */
  usage?: TurnUsage
  cost: number
  usageIncomplete: boolean
  children: number
}
export interface SessionAgentInfo extends SessionRef {
  title: string
  busy: boolean
}
export interface SessionAgentProjectRemoval {
  cwd: string
  cwds: string[]
}
export interface SessionAgentConfiguration {
  controls: SessionControls
  capabilities: SessionCapabilities
}
export type SessionAgentUiRequest = { requestId: string; callerSessionId: string } & (
  | { action: 'project'; project: ProjectGroup }
  | { action: 'create'; session: SessionRef & { title: string }; project: ProjectGroup }
  | { action: 'refresh'; sessionId: string }
  | { action: 'remove-project'; cwd: string; cwds: string[]; phase: 'check' | 'apply' }
  | { action: 'remove'; sessionId: string }
)
export type SessionAgentUiAnswer = { ok: true } | { error: string }
export interface SessionAgentUiApi {
  onRequest(listener: (request: SessionAgentUiRequest) => void): () => void
  answer(requestId: string, answer: SessionAgentUiAnswer): Promise<void>
}
