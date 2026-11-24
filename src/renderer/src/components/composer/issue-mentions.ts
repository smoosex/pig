/**
 * `@` mention candidate selection & serialization for Kanban issues.
 * - Project sessions (including secondary Git worktrees) strictly show ONLY issues assigned to the canonical project root.
 * - Standalone Chats show issues across unassigned and opened projects.
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  formatIssueMention,
  isKanbanActiveStatus,
  resolveCanonicalProjectCwd,
  type KanbanIssue,
  type KanbanStatus
} from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import type { OpenTab } from '../../stores/sessions/types'

export interface IssueMention {
  number: number
  title: string
  status: KanbanStatus
  detail?: string
}

const ISSUE_KEYWORDS = ['issue', 'kanban', 'board', 'task', '看板', '事项', '任务']

export function issueMentionText(item: Pick<IssueMention, 'number'>): string {
  return formatIssueMention(item.number)
}

export function issueMentionLabel(item: Pick<IssueMention, 'number' | 'title'>): string {
  return item.title ? `#${item.number} ${item.title}` : `#${item.number}`
}

export function issueMentionMatches(issue: KanbanIssue, query: string, detail = ''): boolean {
  const raw = query.trim().toLocaleLowerCase()
  if (!raw) {
    return isKanbanActiveStatus(issue.status)
  }
  const strippedNum = raw.startsWith('#') ? raw.slice(1) : raw
  if (/^\d+$/.test(strippedNum) && String(issue.number).startsWith(strippedNum)) {
    return true
  }
  if (issue.status === 'canceled') return false
  return [
    `#${issue.number}`,
    issue.title,
    detail,
    ...issue.labels,
    ...ISSUE_KEYWORDS
  ].some((value) => value.toLocaleLowerCase().includes(raw))
}

export function scopedIssueMentions({
  issues,
  tabs,
  projects,
  currentSessionId,
  cwd,
  chatDraftSessionId,
  query,
  unassignedLabel
}: {
  issues: readonly KanbanIssue[]
  tabs: readonly OpenTab[]
  projects: ReadonlyArray<{ cwd: string; name: string; worktrees?: ReadonlyArray<{ cwd: string }> }>
  currentSessionId?: string | null
  cwd?: string | null
  chatDraftSessionId?: string
  query: string
  unassignedLabel: string
}): IssueMention[] {
  if (issues.length === 0) return []
  const currentTab = tabs.find((tab) => tab.id === currentSessionId)
  const isChatDraft = currentSessionId != null && currentSessionId === chatDraftSessionId
  const isChat = currentTab?.kind === 'chat' || isChatDraft
  const effectiveCwd = currentTab?.cwd ?? cwd ?? null

  const projectNames = new Map(projects.map((p) => [p.cwd, p.name]))

  if (!isChat) {
    const projectRoot = resolveCanonicalProjectCwd(effectiveCwd, projects)
    if (!projectRoot) return []
    return issues
      .filter((issue) => issue.projectCwd === projectRoot && issueMentionMatches(issue, query))
      .slice(0, 20)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        status: issue.status,
        detail: issue.labels.join(' · ')
      }))
  }

  // Standalone Chat: unassigned + all project issues, labeled by project name.
  return issues
    .flatMap((issue): IssueMention[] => {
      const projLabel = issue.projectCwd
        ? (projectNames.get(issue.projectCwd) ?? baseName(issue.projectCwd))
        : unassignedLabel
      const detail = [projLabel, ...issue.labels].filter(Boolean).join(' · ')
      if (!issueMentionMatches(issue, query, detail)) return []
      return [{
        number: issue.number,
        title: issue.title,
        status: issue.status,
        detail
      }]
    })
    .slice(0, 20)
}

export function hasIssueMention(doc: ProseMirrorNode): boolean {
  let found = false
  doc.descendants((node) => {
    found ||= node.type.name === 'issueMention'
    return !found
  })
  return found
}
