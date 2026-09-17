import type { SessionMeta } from '../../ipc/api'

export const EMPTY_SESSION_TITLE = '空会话'
export const EMPTY_CHAT_TITLE = 'Session'
export const NEW_CHAT_TITLE = 'New Session'

export function sessionTitle(session: SessionMeta, kind: 'project' | 'chat' = 'project'): string {
  return session.name || session.firstMessage || (kind === 'chat' ? EMPTY_CHAT_TITLE : EMPTY_SESSION_TITLE)
}

export function isPlaceholderSessionTitle(title: string): boolean {
  return title === EMPTY_SESSION_TITLE || title === EMPTY_CHAT_TITLE || title === NEW_CHAT_TITLE
}
