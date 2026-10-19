/**
 * Lightweight restoration edits user messages from their parent; synchronization keeps the exact leaf.
 * Summarized navigation belongs to Pi, including its summary leaf and extension cancellation.
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { SessionBranchOptions, SessionBranchRef } from '../../shared/api'
import { restoreSessionUserPrompt } from './session-user-prompt'

type BranchSession = Pick<AgentSession,
  'sessionManager' | 'isStreaming' | 'isBashRunning' | 'isCompacting' |
  'refreshContext' | 'extensionRunner' | 'navigateTree' | 'abortBranchSummary'>

export function validateSessionBranchOptions(options?: SessionBranchOptions): void {
  if (!options) return
  if (options.restoreUserInput !== undefined && typeof options.restoreUserInput !== 'boolean') {
    throw new Error('restoreUserInput must be a boolean')
  }
  if (options.summarize !== undefined && typeof options.summarize !== 'boolean') {
    throw new Error('summarize must be a boolean')
  }
  if (options.customInstructions !== undefined &&
      (typeof options.customInstructions !== 'string' || !options.customInstructions.trim())) {
    throw new Error('customInstructions must be a non-empty string')
  }
  if (options.customInstructions !== undefined && options.summarize !== true) {
    throw new Error('customInstructions requires summarize')
  }
}

export async function switchSessionBranch(
  session: BranchSession,
  tipId: string,
  options?: SessionBranchOptions,
  signal?: AbortSignal
): Promise<Pick<SessionBranchRef, 'leafId' | 'restoredPrompt' | 'cancelled'>> {
  validateSessionBranchOptions(options)
  if (session.isStreaming || session.isBashRunning || session.isCompacting) throw new Error('Session is busy')
  const sm = session.sessionManager
  const target = sm.getEntry(tipId)
  if (!target) throw new Error(`Entry not found: ${tipId}`)
  let leafId: string | null = tipId
  let restoredPrompt: SessionBranchRef['restoredPrompt']
  if (options?.restoreUserInput && target.type === 'message' && target.message.role === 'user') {
    const restored = restoreSessionUserPrompt(sm, target)
    leafId = restored.parentId
    restoredPrompt = restored.prompt
  }
  if (options?.summarize) {
    // A stop can arrive while the session is still being prepared, before Pi owns an abort controller.
    if (signal?.aborted) return { leafId: sm.getLeafId(), cancelled: true }
    // navigateTree creates its controller synchronously, so a later stop always reaches the summary.
    const abort = () => session.abortBranchSummary()
    signal?.addEventListener('abort', abort, { once: true })
    let result: Awaited<ReturnType<BranchSession['navigateTree']>>
    try {
      result = await session.navigateTree(tipId, {
        summarize: true,
        ...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {})
      })
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    if (result.cancelled || result.aborted) return { leafId: sm.getLeafId(), cancelled: true }
    // Pi places summaries after a user entry's parent (which may include pasted-text metadata).
    // Never re-branch to the restored prompt's parent and discard that newly persisted summary.
    if (sm.getLeafId() !== tipId || result.summaryEntry) {
      return { leafId: sm.getLeafId(), ...(restoredPrompt ? { restoredPrompt } : {}) }
    }
    // Pi treats its current leaf as a no-op; a current user still needs editable restoration.
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
