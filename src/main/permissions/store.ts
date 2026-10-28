/**
 * Pig-only permission state: `$PIG_DIR/permissions.json` for the default mode and allowed hosts, and a
 * sidecar per session for its mode. Both sit under the data directory the sandbox denies and the file
 * tools treat as protected, so an agent cannot widen its own permissions. Reads are strict: a damaged
 * file stops the tools instead of silently resetting them to a looser default.
 */
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_PERMISSION_MODE, isPermissionDomain, isPermissionMode,
  type PermissionMode, type PermissionProject, type SessionPermission
} from '../../shared/permissions'
import { pigPath } from '../pig-dir'
import { privateJson } from '../mcp/sdk'

export interface PermissionSettings {
  defaultMode: PermissionMode
  domains: string[]
  projects: PermissionProject[]
}

const settingsPath = () => pigPath('permissions.json')
const listeners = new Set<() => void>()

/** Settings or any session's mode changed, from the settings page or a bash approval. */
export function onPermissionsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function changed(): void {
  for (const listener of listeners) listener()
}

function sessionPath(sessionId: string): string {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session id')
  return join(pigPath('session-permissions'), `${sessionId}.json`)
}

function domains(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isPermissionDomain)) throw new Error('Invalid permissions.json: domains')
  return [...new Set(value)]
}

function readOptional(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function readPermissionSettings(): PermissionSettings {
  const raw = readOptional(settingsPath()) as Record<string, unknown> | undefined
  if (raw === undefined) return { defaultMode: DEFAULT_PERMISSION_MODE, domains: [], projects: [] }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !isPermissionMode(raw.defaultMode) ||
    !raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
    throw new Error('Invalid permissions.json')
  }
  const projects = Object.entries(raw.projects as Record<string, { domains?: unknown }>).map(([root, project]) => {
    if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('Invalid permissions.json: project')
    return { root, domains: domains(project?.domains) }
  })
  return { defaultMode: raw.defaultMode, domains: domains(raw.domains), projects }
}

let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(action: () => Promise<T> | T): Promise<T> {
  const result = queue.then(action)
  queue = result.catch(() => undefined) // Keep later mutations usable; the caller still receives the rejection.
  return result
}

/** Read-modify-write in one queue so concurrent approvals cannot drop each other. */
export function updatePermissionSettings(update: (current: PermissionSettings) => PermissionSettings): Promise<PermissionSettings> {
  return serialize(() => {
    const next = update(readPermissionSettings())
    privateJson(settingsPath(), {
      version: 1,
      defaultMode: next.defaultMode,
      domains: next.domains,
      projects: Object.fromEntries(next.projects.filter((project) => project.domains.length).map((project) => [project.root, { domains: project.domains }]))
    })
    changed()
    return next
  })
}

export function projectDomains(settings: PermissionSettings, root: string | null): string[] {
  return root ? settings.projects.find((project) => project.root === root)?.domains ?? [] : []
}

function readSessionMode(sessionId: string): PermissionMode | null {
  const raw = readOptional(sessionPath(sessionId)) as { mode?: unknown } | undefined
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || !isPermissionMode(raw.mode)) throw new Error('Invalid session permissions')
  return raw.mode
}

export function sessionPermission(sessionId: string): SessionPermission {
  const mode = readSessionMode(sessionId)
  return mode ? { mode, overridden: true } : { mode: readPermissionSettings().defaultMode, overridden: false }
}

export async function saveSessionPermission(sessionId: string, mode: PermissionMode | null): Promise<void> {
  if (mode !== null && !isPermissionMode(mode)) throw new Error('Invalid permission mode')
  await serialize(async () => {
    if (mode === null) await rm(sessionPath(sessionId), { force: true })
    else privateJson(sessionPath(sessionId), { mode })
    changed()
  })
}

/** A fork keeps its source's mode; a session following the default leaves no file. */
export function copySessionPermission(from: string, to: string): Promise<void> {
  return serialize(async () => {
    const mode = readSessionMode(from)
    if (mode) privateJson(sessionPath(to), { mode })
    else await rm(sessionPath(to), { force: true })
  })
}

export async function removeSessionPermission(sessionId: string): Promise<void> {
  await serialize(() => rm(sessionPath(sessionId), { force: true }))
}
