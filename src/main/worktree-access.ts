/**
 * Which directories a window is allowed to name. Every file and diff call starts from a cwd the renderer
 * sent, and the guards in `files/paths.ts` only constrain the part *within* a root — the root itself has
 * to be one the user opened, or `readFile('/etc', 'hosts')` sails through all of them. A project is its
 * own worktree, and the rest of a project's worktrees come from git, wherever it put them.
 *
 * Discovery runs git, so an answer is remembered by the spelling that came in. Only the positive ones are:
 * a worktree created after this process started has to work without anyone restarting it.
 */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import * as chats from './chats'
import { listOpenedCwds } from './opened-projects'
import { t } from './i18n'
import { repositoryWorktrees } from './worktrees'

const known = new Set<string>()

/**
 * The worktree this cwd names, or null when it is not part of any opened project or standalone chat.
 * Links are resolved to judge the path — a worktree is the same directory however a window spells it,
 * and git reports its own spelling — but the answer keeps the spelling that came in. Chat directories
 * (`$PIG_DIR/chats/<id>`) are verified live via `lstat` rather than cached so a deleted chat stops
 * resolving immediately and symlinks inside `chats/` cannot escape.
 */
export async function openedWorktree(cwd: unknown): Promise<string | null> {
  if (typeof cwd !== 'string' || !cwd) return null
  const path = resolve(cwd)
  if (known.has(path)) return path

  const chatsRoot = resolve(chats.chatsDir?.() ?? '')
  if (dirname(path) === chatsRoot) {
    const info = await lstat(path).catch(() => null)
    return info?.isDirectory() ? path : null
  }

  const real = await realpath(path).catch(() => path)
  const realChatsRoot = await realpath(chatsRoot).catch(() => chatsRoot)
  if (dirname(real) === realChatsRoot) {
    const info = await lstat(real).catch(() => null)
    if (info?.isDirectory()) return path
  }

  const opened = await listOpenedCwds()
  if (opened.includes(path) || opened.includes(real)) {
    known.add(path)
    return path
  }
  for (const projectCwd of opened) {
    // A project that is not a repository, or one whose git cannot answer, simply offers no worktrees.
    const branches = await repositoryWorktrees(projectCwd).catch(() => [])
    if (branches.some((branch) => branch.cwd === path || branch.cwd === real)) {
      known.add(path)
      return path
    }
  }
  return null
}

/** The same answer, refusing out loud: a window that asks for some other directory gets nothing. */
export async function requireWorktree(cwd: unknown): Promise<string> {
  const path = await openedWorktree(cwd)
  if (!path) throw new Error(t('error.notAnOpenWorkspace'))
  return path
}

export function forgetKnownWorktrees(cwds: Iterable<string>): void {
  for (const cwd of cwds) {
    if (typeof cwd === 'string' && cwd) known.delete(resolve(cwd))
  }
}
