/** Shared project registration for the directory picker and authorized session-control tools. */
import { resolveProjectDirectory } from './project-directory-browser'
import { addOpenedProject } from './opened-projects'
import { canonicalProject } from './worktrees'
import { isChatCwd, isChatsRoot } from './chats'
import { loadWorktreeProject } from './project-worktrees'

export async function openProjectDirectory(path: string) {
  const picked = await resolveProjectDirectory(path)
  if (isChatCwd(picked) || isChatsRoot(picked)) throw new Error('Chat directories cannot be opened as projects')
  const cwd = await addOpenedProject(await canonicalProject(picked))
  return loadWorktreeProject(cwd)
}
