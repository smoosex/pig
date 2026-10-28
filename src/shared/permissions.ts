/** Session permission modes and the sandbox state shared by main, preload and the renderer. */

/**
 * `read-only`: nothing outside temporary directories is writable and the network is closed.
 * `default`: shell commands run in the OS sandbox; file tools ask outside the session workspace.
 * `full-access`: no sandbox and no questions.
 */
export const PERMISSION_MODES = ['read-only', 'default', 'full-access'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'

/** `pending` until the first sandboxed command or settings read starts it. */
export type SandboxState = 'pending' | 'ready' | 'unavailable' | 'unsupported'
export interface SandboxStatus {
  state: SandboxState
  /** Why the sandbox cannot run; shown as is. */
  detail?: string
}

export interface PermissionProject {
  /** The repository's Git common directory, shared by all of its worktrees. */
  root: string
  domains: string[]
}

export interface PermissionsSnapshot {
  defaultMode: PermissionMode
  /** Hosts allowed for every session, beyond the built-in package registries. */
  domains: string[]
  projects: PermissionProject[]
  sandbox: SandboxStatus
}

export interface SessionPermission {
  mode: PermissionMode
  /** False while the session follows the default mode. */
  overridden: boolean
}

export interface PermissionsApi {
  getPermissions(): Promise<PermissionsSnapshot>
  setDefaultPermissionMode(mode: PermissionMode): Promise<PermissionsSnapshot>
  /** A null project removes a global host. */
  removePermissionDomain(project: string | null, domain: string): Promise<PermissionsSnapshot>
  getSessionPermission(sessionId: string): Promise<SessionPermission>
  /** Null returns the session to the default mode. */
  setSessionPermission(sessionId: string, mode: PermissionMode | null): Promise<SessionPermission>
  /** Any settings or session mode change. */
  onPermissionsChanged(listener: () => void): () => void
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value)
}

// Host patterns as srt accepts them: a name, or `*.` followed by a name. No ports or paths.
const HOST = /^(\*\.)?([a-z\d]([a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d]([a-z\d-]{0,61}[a-z\d])?$/

export function isPermissionDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && HOST.test(value)
}
