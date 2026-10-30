/** A session's recorded edit/write operations, read from its branch rather than from Git. */
import type { SessionFileChange } from './session-file-changes'

export interface FileChangeSummary extends Omit<SessionFileChange, 'operations'> {
  /** Worktree-relative with `/` separators when the file sits inside the session's cwd, otherwise null. */
  relativePath: string | null
  operationCount: number
}

export interface SessionFileChangesSummary {
  leafId: string | null
  files: FileChangeSummary[]
  /** Keyed by display turn id: the entry that opened the turn, as the conversation groups it. */
  turns: Record<string, FileChangeSummary[]>
}

export type TurnFileChange = SessionFileChange & { relativePath: string | null }

export interface TurnFileChangesResult {
  leafId: string | null
  /** Empty when the turn is not on the current branch or changed nothing. */
  files: TurnFileChange[]
}
