import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { OpenTab } from '../../stores/sessions/types'

export interface TabMention {
  kind: 'browser' | 'terminal' | 'session'
  id: string
  title: string
  detail?: string
}

/** Display order of the groups in the `@` menu. */
export const TAB_MENTION_KINDS = ['session', 'browser', 'terminal'] as const

/** Type words in both languages, so `browser` finds browsers whatever the UI language is. */
const KIND_KEYWORDS: Record<TabMention['kind'], string[]> = {
  session: ['session', 'chat', '会话', '聊天'],
  browser: ['browser', 'web', '浏览器', '网页'],
  terminal: ['terminal', 'shell', '终端']
}

export function tabMentionMatches(item: TabMention, query: string): boolean {
  const needle = query.toLocaleLowerCase()
  return [item.title, item.id, item.detail ?? '', ...KIND_KEYWORDS[item.kind]].some((value) => value.toLocaleLowerCase().includes(needle))
}

export function tabMentions(tabs: OpenTab[], currentSessionId?: string | null): TabMention[] {
  const items = tabs.flatMap((tab): TabMention[] => {
    const kind = tab.kind === 'project' || tab.kind === 'chat' ? 'session' : tab.kind
    if ((kind !== 'browser' && kind !== 'terminal' && kind !== 'session') || (kind === 'session' && tab.id === currentSessionId)) return []
    // A Chat's cwd is its private scratch folder under Pig's data directory, which says nothing to the user.
    const item: TabMention = { kind, id: tab.id, title: tab.title, detail: tab.kind === 'chat' ? '' : tab.cwd }
    return [item]
  })
  return TAB_MENTION_KINDS.flatMap((kind) => items.filter((item) => item.kind === kind))
}

/** Browsers and terminals have no names of their own, so the label carries a short form of the stable ID. */
export function tabMentionLabel({ kind, id, title }: Pick<TabMention, 'kind' | 'id' | 'title'>): string {
  if (kind === 'session') return title
  return `${title}: ${id.slice(id.indexOf(':') + 1, id.indexOf(':') + 9)}`
}

export function tabMentionText(item: TabMention): string {
  return `@[${item.kind}:${item.id}]`
}

export function hasTabMention(doc: ProseMirrorNode): boolean {
  let found = false
  doc.descendants((node) => {
    found ||= node.type.name === 'tabMention'
    return !found
  })
  return found
}
