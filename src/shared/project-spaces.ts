/**
 * Shared IPC contract and pure resolution helpers for Project Spaces ("空间").
 * Spaces partition the sidebar project list while keeping `opened-projects.json` as the global
 * authorization and session catalog truth across all spaces.
 */

export const DEFAULT_SPACE_ID = 'default'

export const PROJECT_SPACE_ICONS = [
  'dot',
  'sparkles',
  'folder',
  'code',
  'terminal',
  'rocket',
  'layers',
  'globe',
  'compass',
  'flask',
  'palette',
  'database',
  'book',
  'cpu',
  'wrench',
  'star'
] as const

export type ProjectSpaceIcon = (typeof PROJECT_SPACE_ICONS)[number]

export interface ProjectSpace {
  id: string
  /** Empty string on `DEFAULT_SPACE_ID` renders the localized default label ("默认" / "Default"). */
  name: string
  icon?: ProjectSpaceIcon
}

export interface ProjectSpacesSnapshot {
  revision: number
  activeSpaceId: string
  spaces: ProjectSpace[]
  /** Maps canonical project root `cwd` to its owning `space.id`. */
  assignments: Record<string, string>
}

export interface CreateProjectSpaceInput {
  name: string
  icon?: ProjectSpaceIcon
  /** Optional project root to assign into the new space atomically on creation. */
  moveProjectCwd?: string
  /** Defaults to true; set false to create and move a project without switching away from the current space. */
  activate?: boolean
}

export interface UpdateProjectSpaceInput {
  id: string
  name?: string
  icon?: ProjectSpaceIcon | null
}

export interface ProjectSpacesApi {
  getSnapshot: () => Promise<ProjectSpacesSnapshot>
  select: (spaceId: string) => Promise<ProjectSpacesSnapshot>
  create: (input: CreateProjectSpaceInput) => Promise<ProjectSpacesSnapshot>
  update: (input: UpdateProjectSpaceInput) => Promise<ProjectSpacesSnapshot>
  remove: (id: string) => Promise<ProjectSpacesSnapshot>
  assignProject: (cwd: string, spaceId: string) => Promise<ProjectSpacesSnapshot>
  forgetProject: (cwd: string) => Promise<ProjectSpacesSnapshot>
  onChanged: (listener: (snapshot: ProjectSpacesSnapshot) => void) => () => void
}

export function createDefaultSpacesSnapshot(): ProjectSpacesSnapshot {
  return {
    revision: 0,
    activeSpaceId: DEFAULT_SPACE_ID,
    spaces: [{ id: DEFAULT_SPACE_ID, name: '' }],
    assignments: {}
  }
}

export function isProjectSpaceIcon(value: unknown): value is ProjectSpaceIcon {
  return typeof value === 'string' && (PROJECT_SPACE_ICONS as readonly string[]).includes(value)
}

export function fallbackSpaceId(spaces: readonly ProjectSpace[]): string {
  return spaces.find((space) => space.id === DEFAULT_SPACE_ID)?.id ?? spaces[0]?.id ?? DEFAULT_SPACE_ID
}

export function resolveProjectSpaceId(
  state: Pick<ProjectSpacesSnapshot, 'spaces' | 'assignments'>,
  cwd: string
): string {
  const assigned = state.assignments[cwd]
  if (assigned && state.spaces.some((space) => space.id === assigned)) {
    return assigned
  }
  return fallbackSpaceId(state.spaces)
}
