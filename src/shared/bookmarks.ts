/** Bookmarks reference persisted replies; the JSONL remains the source of conversation content. */
import type { SessionMeta } from './api'

export interface ReplyBookmark {
  id: string
  session: SessionMeta
  kind: 'project' | 'chat'
  turnId: string
  /** Stable assistant reply entry, not the turn's mutable tail. */
  entryId: string
  preview: string
  createdAt: number
}

export interface BookmarkSnapshot {
  revision: number
  items: ReplyBookmark[]
}

export interface BookmarksApi {
  list(): Promise<BookmarkSnapshot>
  add(sessionId: string, turnId: string, entryId: string, title: string): Promise<BookmarkSnapshot>
  remove(id: string): Promise<BookmarkSnapshot>
  locate(id: string): Promise<{ turnIndex: number | null }>
  onChanged(listener: () => void): () => void
}

export function replyBookmarkId(sessionId: string, entryId: string): string {
  return `${sessionId}/${entryId}`
}
