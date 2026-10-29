/** A child may be narrower than its parent, but never wider than either mode. */
import type { PermissionMode } from '../../shared/permissions'

const RANK: Record<PermissionMode, number> = { 'read-only': 0, default: 1, 'full-access': 2 }

export function restrictPermissionMode(ceiling: PermissionMode, parent: PermissionMode): PermissionMode {
  return RANK[ceiling] <= RANK[parent] ? ceiling : parent
}
