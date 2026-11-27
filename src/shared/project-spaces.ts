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
  /** Maps `space.id` to the last active worktree `cwd` viewed in that space. */
  lastCwds?: Record<string, string>
}

export interface SpaceProjectEntry {
  cwd: string
  missing?: boolean
  worktrees?: ReadonlyArray<{ cwd: string; missing?: boolean }>
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
  rememberCwd: (spaceId: string, cwd: string) => Promise<ProjectSpacesSnapshot>
  onChanged: (listener: (snapshot: ProjectSpacesSnapshot) => void) => () => void
}

export function createDefaultSpacesSnapshot(): ProjectSpacesSnapshot {
  return {
    revision: 0,
    activeSpaceId: DEFAULT_SPACE_ID,
    spaces: [{ id: DEFAULT_SPACE_ID, name: '' }],
    assignments: {},
    lastCwds: {}
  }
}

export function isProjectSpaceIcon(value: unknown): value is ProjectSpaceIcon {
  return typeof value === 'string' && (PROJECT_SPACE_ICONS as readonly string[]).includes(value)
}

export function fallbackSpaceId(spaces: readonly ProjectSpace[]): string {
  return spaces.find((space) => space.id === DEFAULT_SPACE_ID)?.id ?? spaces[0]?.id ?? DEFAULT_SPACE_ID
}

export function resolveProjectSpaceId(
  state: { spaces: readonly ProjectSpace[]; assignments: Readonly<Record<string, string>> },
  cwd: string
): string {
  const assigned = state.assignments[cwd]
  if (assigned && state.spaces.some((space) => space.id === assigned)) {
    return assigned
  }
  return fallbackSpaceId(state.spaces)
}

/** Finds the canonical project root `project.cwd` that owns `worktreeCwd`, or null if none. */
export function owningProjectCwd(
  projects: readonly SpaceProjectEntry[],
  worktreeCwd: string | null | undefined
): string | null {
  if (!worktreeCwd) return null
  for (const project of projects) {
    if (project.cwd === worktreeCwd) return project.cwd
    if (project.worktrees?.some((wt) => wt.cwd === worktreeCwd)) return project.cwd
  }
  return null
}

/** Resolves which space owns `worktreeCwd`, or null when `worktreeCwd` is not in `projects`. */
export function resolveWorktreeSpaceId(
  state: { spaces: readonly ProjectSpace[]; assignments: Readonly<Record<string, string>> },
  projects: readonly SpaceProjectEntry[],
  worktreeCwd: string | null | undefined
): string | null {
  const rootCwd = owningProjectCwd(projects, worktreeCwd)
  return rootCwd ? resolveProjectSpaceId(state, rootCwd) : null
}

/**
 * Picks the worktree `cwd` the main content area should display for `spaceId`:
 * 1. `lastCwds[spaceId]` if it still belongs to a project in `spaceId`
 * 2. The first worktree in `spaceId` that has open or restored content
 * 3. The first project in `spaceId` (preferring non-missing directories), which opens its New Session home
 * 4. `null` when `spaceId` has zero projects (showing the Empty Projects screen)
 */
export function resolveSpaceTargetCwd(input: {
  spaceId: string
  spaces: readonly ProjectSpace[]
  assignments: Readonly<Record<string, string>>
  lastCwds?: Readonly<Record<string, string>>
  projects: readonly SpaceProjectEntry[]
  hasOpenContent?: (cwd: string) => boolean
}): string | null {
  const { spaceId, spaces, assignments, lastCwds, projects, hasOpenContent } = input
  const spaceProjects = projects.filter(
    (project) => resolveProjectSpaceId({ spaces, assignments }, project.cwd) === spaceId
  )
  if (spaceProjects.length === 0) return null

  const validWorktrees = new Set<string>()
  const orderedWorktrees: string[] = []
  const push = (cwd: string) => {
    if (!validWorktrees.has(cwd)) {
      validWorktrees.add(cwd)
      orderedWorktrees.push(cwd)
    }
  }
  for (const project of spaceProjects) {
    if (project.worktrees && project.worktrees.length > 0) {
      for (const wt of project.worktrees) {
        if (!wt.missing) push(wt.cwd)
      }
      for (const wt of project.worktrees) {
        if (wt.missing) push(wt.cwd)
      }
    }
    push(project.cwd)
  }

  const remembered = lastCwds?.[spaceId]
  if (remembered && validWorktrees.has(remembered)) {
    return remembered
  }

  if (hasOpenContent) {
    const withContent = orderedWorktrees.find((cwd) => hasOpenContent(cwd))
    if (withContent) return withContent
  }

  const healthy = spaceProjects.find((project) => !project.missing) ?? spaceProjects[0]!
  const primaryWt =
    healthy.worktrees?.find((wt) => !wt.missing && wt.cwd === healthy.cwd) ??
    healthy.worktrees?.find((wt) => !wt.missing)
  return primaryWt?.cwd ?? healthy.cwd
}
