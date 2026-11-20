/** Temporary Bot runtime policy; ordinary session preferences and permissions are separate. */
import type { PermissionMode } from '../../shared/permissions'
import { sessionPermission } from '../permissions/store'
import { readSessionCapabilities } from './session-capabilities'

export interface ManagedOverlay {
  mode: 'read' | 'write'
  browser?: boolean
}

export const managedOverlays = new Map<string, ManagedOverlay>()

export function runtimePermissionMode(sessionId: string): PermissionMode {
  return managedOverlays.get(sessionId)?.mode === 'read' ? 'read-only' : sessionPermission(sessionId).mode
}

export function runtimeSessionCapabilities(sessionId: string) {
  const prefs = readSessionCapabilities(sessionId)
  if (managedOverlays.get(sessionId)?.mode !== 'read') return prefs
  return { ...prefs, tools: { ...prefs.tools, edit: false, write: false } }
}
