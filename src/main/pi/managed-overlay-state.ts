/** Zero-dependency Bot runtime overlay map shared with event-bridge and session capabilities. */
export interface ManagedOverlay {
  mode: 'read' | 'write'
  browser?: boolean
}

export const managedOverlays = new Map<string, ManagedOverlay>()
