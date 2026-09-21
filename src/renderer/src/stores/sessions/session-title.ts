import type { SessionMeta } from '../../ipc/api'

export const EMPTY_SESSION_TITLE = '新对话'

export function sessionTitle(session: SessionMeta): string {
  return session.name || session.firstMessage || EMPTY_SESSION_TITLE
}

export function isPlaceholderSessionTitle(title: string): boolean {
  return title === EMPTY_SESSION_TITLE
}
