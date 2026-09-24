import type { OpenTab } from '../stores/sessions/types'
import type { SidebarTab } from '../../../shared/api'

/**
 * A project's tabs need a worktree to belong to, so with none open the strip falls back to chats:
 * that is the only thing the pane can be showing there. The sidebar still lists projects, because
 * opening one is how a worktree arrives.
 */
export function stripShowsChats(tab: SidebarTab, currentProjectCwd: string | null): boolean {
  return tab === 'chats' || currentProjectCwd === null
}

/** Which tabs the strip shows. The projects half adds file and diff tabs of the open worktree. */
export function visibleTabsFor(
  tabs: OpenTab[],
  tab: SidebarTab,
  currentProjectCwd: string | null
): OpenTab[] {
  return stripShowsChats(tab, currentProjectCwd)
    ? tabs.filter((item) => item.kind === 'chat')
    : tabs.filter((item) => item.kind !== 'chat' && item.cwd === currentProjectCwd)
}

/**
 * What the content pane has to do when the switcher moves to a half, so the pane shows what the
 * strip shows instead of the half just left. A half that already holds the focused tab asks for
 * nothing: the switcher is not allowed to invent a session. The chats half with nothing open asks
 * for its home instead, which is the chat the first message will create.
 */
export type HalfSwitch =
  | { kind: 'none' }
  | { kind: 'chat'; tabId: string }
  | { kind: 'project'; cwd: string }
  | { kind: 'chatHome' }

/**
 * The projects half returns to the worktree it was left in rather than activating a tab directly:
 * a chat clears `currentProjectCwd`, and the worktree already remembers the tab it was left on, so
 * going back also restores project home when that is where the reader was. The memory can outlive the
 * worktree (unpinning or deleting a project drops its cwds), so a remembered one is only used while
 * something still holds it: a listed worktree, or a tab of its own. Otherwise the half falls back to
 * the newest tab it has, the way the chats half does.
 */
export function halfSwitch(
  tabs: OpenTab[],
  next: SidebarTab,
  activeTabId: string | null,
  currentProjectCwd: string | null,
  lastChatTabId: string | null,
  lastProjectCwd: string | null,
  knownProjectCwds: ReadonlySet<string>
): HalfSwitch {
  const active = tabs.find((item) => item.id === activeTabId)
  if (next === 'chats') {
    if (active?.kind === 'chat') return { kind: 'none' }
    const chats = tabs.filter((item) => item.kind === 'chat')
    const target = chats.find((item) => item.id === lastChatTabId) ?? chats.at(-1)
    return target ? { kind: 'chat', tabId: target.id } : { kind: 'chatHome' }
  }
  if (active && active.kind !== 'chat') return { kind: 'none' }
  const held = (cwd: string | null): string | null =>
    cwd && (knownProjectCwds.has(cwd) || tabs.some((tab) => tab.kind !== 'chat' && tab.cwd === cwd))
      ? cwd
      : null
  const cwd = held(lastProjectCwd) ?? held(currentProjectCwd)
  if (cwd) return { kind: 'project', cwd }
  // Without a worktree the strip falls back to chats, so the pane has nothing of this half to show.
  if (currentProjectCwd === null) return { kind: 'none' }
  const newest = tabs.findLast((item) => item.kind !== 'chat')
  return newest ? { kind: 'project', cwd: newest.cwd } : { kind: 'none' }
}
