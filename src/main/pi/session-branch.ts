/**
 * Tree restoration edits user messages from their parent; branch synchronization keeps the exact leaf.
 * Stored entries remain untouched, so sending the restored prompt creates a new branch.
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { SessionBranchOptions, SessionBranchRef } from '../../shared/api'

type BranchSession = Pick<AgentSession, 'sessionManager' | 'isStreaming' | 'isBashRunning' | 'refreshContext' | 'extensionRunner'>

export async function switchSessionBranch(
  session: BranchSession,
  tipId: string,
  options?: SessionBranchOptions
): Promise<Pick<SessionBranchRef, 'leafId' | 'restoredPrompt'>> {
  if (session.isStreaming || session.isBashRunning) throw new Error('Session is busy')
  const sm = session.sessionManager
  const target = sm.getEntry(tipId)
  if (!target) throw new Error(`Entry not found: ${tipId}`)
  let leafId: string | null = tipId
  let restoredPrompt: SessionBranchRef['restoredPrompt']
  if (options?.restoreUserInput && target.type === 'message' && target.message.role === 'user') {
    leafId = target.parentId
    const content = target.message.content
    restoredPrompt = {
      text: typeof content === 'string' ? content : content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      images: typeof content === 'string' ? [] : content.filter((block) => block.type === 'image').map(({ mimeType, data }) => ({ mimeType, data }))
    }
  }
  if (sm.getLeafId() !== leafId) {
    const oldLeafId = sm.getLeafId()
    if (leafId === null) sm.resetLeaf()
    else sm.branch(leafId)
    session.refreshContext()
    // Plugins must leave the abandoned branch together with the visible transcript.
    await session.extensionRunner.emit({ type: 'session_tree', newLeafId: sm.getLeafId(), oldLeafId })
  }
  return { leafId: sm.getLeafId(), ...(restoredPrompt ? { restoredPrompt } : {}) }
}
