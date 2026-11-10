/** Stable project identity; Chat scratch must not inherit its enclosing development checkout. */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { dirname, join } from 'node:path'
import { realTarget } from '../../../sandbox/path'
import { sessionWorkspace } from '../../../sandbox/workspace'
export interface MemoryAccess { project: string; session: string; cwd: string }

export async function memoryAccess(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>): Promise<MemoryAccess> {
  const workspace = await sessionWorkspace(ctx.cwd)
  const session = ctx.sessionManager.getSessionId()
  const chats = realTarget(join(process.env.PIG_DIR || join(process.cwd(), '.pig'), 'chats'))
  // Development Chat scratch directories sit inside the Pig repository. They must never inherit
  // that enclosing repository's project memories merely because Git discovery walks upwards.
  const chat = workspace.cwd === chats || dirname(workspace.cwd) === chats
  return { project: chat ? `chat:${session}` : workspace.gitCommonDir ?? workspace.cwd, session, cwd: workspace.cwd }
}
