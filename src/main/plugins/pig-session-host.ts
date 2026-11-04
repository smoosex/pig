/** Shared registry between the jiti extension and main's same-window session services. */
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { ProjectGroup } from '../../shared/api'
import type { SessionAgentConfig, SessionAgentCreate, SessionAgentConfiguration, SessionAgentInfo, SessionAgentTask, SessionAgentProjectRemoval } from '../../shared/session-agent'

export interface SessionActionContext {
  signal?: AbortSignal
  ui?: Pick<ExtensionUIContext, 'select'>
}
export interface SessionReadHost {
  read(caller: string, target: string, offset: number, limit: number): Promise<string>
}
export interface SessionAgentHost {
  list(caller: string): Promise<SessionAgentInfo[]>
  openProject(caller: string, path: string, context: SessionActionContext): Promise<ProjectGroup>
  removeProject(caller: string, path: string, context: SessionActionContext): Promise<SessionAgentProjectRemoval>
  create(caller: string, options: SessionAgentCreate, context: SessionActionContext): Promise<SessionAgentInfo>
  configuration(caller: string, target: string): Promise<SessionAgentConfiguration>
  configure(caller: string, target: string, config: SessionAgentConfig, context: SessionActionContext): Promise<SessionAgentConfiguration>
  send(caller: string, target: string, text: string, context: SessionActionContext): Promise<SessionAgentTask>
  status(caller: string, taskId: string): Promise<SessionAgentTask>
  wait(caller: string, taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ timedOut: boolean; task: SessionAgentTask }>
  stop(caller: string, target: string, context: SessionActionContext): Promise<void>
}
const key = Symbol.for('pig:session-read-host')
const agentKey = Symbol.for('pig:session-agent-host')
type Slot = Record<symbol, SessionReadHost | SessionAgentHost | undefined>
export function registerSessionReadHost(host: SessionReadHost): void { (globalThis as Slot)[key] = host }
export function sessionReadHost(): SessionReadHost | undefined { return (globalThis as Slot)[key] as SessionReadHost | undefined }
export function registerSessionAgentHost(host: SessionAgentHost): void { (globalThis as Slot)[agentKey] = host }
export function sessionAgentHost(): SessionAgentHost | undefined { return (globalThis as Slot)[agentKey] as SessionAgentHost | undefined }
