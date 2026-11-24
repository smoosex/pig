/**
 * Shared Kanban contracts, status/priority constants, @issue mention helpers, and worktree-to-project
 * scope resolution shared across main, preload, renderer, and system plugins.
 */

export const KANBAN_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled'
] as const

export const KANBAN_BOARD_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done'
] as const

export const KANBAN_PRIORITIES = [
  'none',
  'urgent',
  'high',
  'medium',
  'low'
] as const

export const KANBAN_DEFAULT_LABELS = [
  'Feature',
  'Bug',
  'Improvement'
] as const

export type KanbanStatus = (typeof KANBAN_STATUSES)[number]
export type KanbanBoardStatus = (typeof KANBAN_BOARD_STATUSES)[number]
export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number]
export type KanbanDefaultLabel = (typeof KANBAN_DEFAULT_LABELS)[number]

export function isKanbanStatus(value: unknown): value is KanbanStatus {
  return typeof value === 'string' && (KANBAN_STATUSES as readonly string[]).includes(value)
}

export function isKanbanPriority(value: unknown): value is KanbanPriority {
  return typeof value === 'string' && (KANBAN_PRIORITIES as readonly string[]).includes(value)
}

export function isKanbanActiveStatus(status: KanbanStatus): boolean {
  return status !== 'done' && status !== 'canceled'
}

export interface KanbanLinkedSession {
  sessionId: string
  cwd: string
}

export interface KanbanImageAttachment {
  id: string
  mimeType: string
  size: number
  name?: string
}

export type KanbanImageInput =
  | { id: string }
  | { id?: string; mimeType: string; data: string; name?: string }

export interface KanbanIssue {
  id: string
  number: number
  title: string
  description: string
  status: KanbanStatus
  priority: KanbanPriority
  /** Canonical root cwd of an opened project, or null for unassigned (Inbox) issues. */
  projectCwd: string | null
  labels: string[]
  images: KanbanImageAttachment[]
  sortOrder: number
  linkedSessions: KanbanLinkedSession[]
  linkedBotTaskIds: string[]
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface KanbanSnapshot {
  revision: number
  nextNumber: number
  items: KanbanIssue[]
}

export interface KanbanCreateInput {
  title: string
  description?: string
  status?: KanbanStatus
  priority?: KanbanPriority
  projectCwd?: string | null
  labels?: string[]
  images?: KanbanImageInput[]
}

export interface KanbanUpdateInput {
  number: number
  title?: string
  description?: string
  status?: KanbanStatus
  priority?: KanbanPriority
  projectCwd?: string | null
  labels?: string[]
  images?: KanbanImageInput[]
  sortOrder?: number
}

export interface KanbanListFilter {
  status?: KanbanStatus | KanbanStatus[]
  priority?: KanbanPriority
  query?: string
  /** Omit (`undefined`) for all projects + unassigned; pass `null` for unassigned only; pass `string` for a specific project. */
  projectCwd?: string | null
  includeDone?: boolean
  includeCanceled?: boolean
}

export interface KanbanApi {
  getSnapshot: () => Promise<KanbanSnapshot>
  create: (input: KanbanCreateInput) => Promise<{ issue: KanbanIssue; snapshot: KanbanSnapshot }>
  update: (input: KanbanUpdateInput) => Promise<{ issue: KanbanIssue; snapshot: KanbanSnapshot }>
  delete: (number: number) => Promise<KanbanSnapshot>
  copyIssue: (number: number) => Promise<string>
  onChanged: (listener: (snapshot: KanbanSnapshot) => void) => () => void
}

export interface KanbanAgentCaller {
  sessionId: string
  cwd?: string
  isBotMain?: boolean
}

export interface KanbanAgentIssueDetail {
  issue: KanbanIssue
  imageBlocks?: Array<{ mimeType: string; data: string }>
}

export interface KanbanAgentHost {
  get: (caller: KanbanAgentCaller, number: number) => Promise<KanbanAgentIssueDetail>
  list: (caller: KanbanAgentCaller, filter: KanbanListFilter) => Promise<KanbanIssue[]>
  create: (caller: KanbanAgentCaller, input: KanbanCreateInput) => Promise<KanbanIssue>
  update: (caller: KanbanAgentCaller, input: KanbanUpdateInput) => Promise<KanbanIssue>
  remove: (
    caller: KanbanAgentCaller,
    number: number,
    options?: {
      signal?: AbortSignal
      confirm?: (title: string, message: string) => Promise<boolean>
    }
  ) => Promise<{ deleted: boolean; number: number }>
}

const ISSUE_MENTION_PATTERN = /@\[issue:(\d+)\]/g
const SAFE_IMAGE_ID = /^[a-zA-Z0-9_-]{1,80}(?:\.(?:png|jpg|jpeg|webp|gif))?$/i

export function isSafeKanbanImageId(id: string): boolean {
  return SAFE_IMAGE_ID.test(id)
}

export function kanbanImageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'png'
  }
}

export function formatKanbanIssueClipboardText(input: {
  title: string
  description: string
  imagePaths: readonly string[]
  imagesHeading: string
}): string {
  const sections: string[] = [`# ${input.title.trim()}`]
  const body = input.description.replace(/\r\n?/g, '\n').trim()
  if (body) {
    sections.push(body)
  }
  if (input.imagePaths.length > 0) {
    const list = input.imagePaths.map((p) => `- ${p}`).join('\n')
    sections.push(`## ${input.imagesHeading}\n\n${list}`)
  }
  return sections.join('\n\n')
}

export function kanbanImageUrl(imageId: string): string {
  return `pig-image://kanban/${encodeURIComponent(imageId)}`
}

export function parseKanbanImageUrl(url: string): string | null {
  if (url.includes('..')) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'pig-image:' || parsed.hostname !== 'kanban') return null
  const [rawId, ...rest] = parsed.pathname.split('/').filter(Boolean)
  if (!rawId || rest.length > 0) return null
  try {
    const id = decodeURIComponent(rawId)
    return SAFE_IMAGE_ID.test(id) ? id : null
  } catch {
    return null
  }
}

export function formatIssueMention(number: number): string {
  return `@[issue:${number}]`
}

export function extractIssueMentionNumbers(text: string): number[] {
  if (!text) return []
  const seen = new Set<number>()
  for (const match of text.matchAll(ISSUE_MENTION_PATTERN)) {
    const parsed = Number(match[1])
    if (Number.isSafeInteger(parsed) && parsed >= 1) {
      seen.add(parsed)
    }
  }
  return [...seen]
}

/**
 * Maps a session's cwd (either a primary project directory or one of its isolated Git worktrees)
 * back to the canonical root `project.cwd` registered in Pig. Returns null when not in a project.
 */
export function resolveCanonicalProjectCwd(
  cwd: string | null | undefined,
  projects: ReadonlyArray<{ cwd: string; worktrees?: ReadonlyArray<{ cwd: string }> }>
): string | null {
  if (!cwd) return null
  for (const project of projects) {
    if (project.cwd === cwd) return project.cwd
    if (project.worktrees?.some((worktree) => worktree.cwd === cwd)) return project.cwd
  }
  return null
}
