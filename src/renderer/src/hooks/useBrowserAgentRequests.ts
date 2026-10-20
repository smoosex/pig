import { useEffect } from 'react'
import type { BrowserAgentOpenRequest } from '../../../shared/browser'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'
import { useSessionsStore } from '../stores/sessions'

/** Opens the background tab an agent asked for, in the session's own project worktree or the chat strip. */
export async function answerBrowserAgentOpen({ requestId, sessionId }: BrowserAgentOpenRequest): Promise<void> {
  const store = useSessionsStore.getState()
  const session = store.openTabs.find((tab) => tab.id === sessionId && (tab.kind === 'project' || tab.kind === 'chat'))
  let result: { browserId: string } | { error: string }
  try {
    if (!session) throw new Error('The session is not open in this window')
    result = { browserId: await store.openBrowserTab(session.kind === 'chat' ? null : session.cwd, { background: true, targetSessionId: sessionId }) }
  } catch (error) {
    // The agent's tool call is the one waiting: the failure goes back to it as the answer.
    result = { error: failureMessage(error) }
  }
  await api.browser.answerAgentOpen(requestId, result)
}

/** Main asks for a browser tab when an agent calls browser_open; tabs are UI state, so the strip creates it. */
export function useBrowserAgentRequests(): void {
  useEffect(() => api.browser.onAgentOpenRequest((request) => {
    // A failed answer means the window or request is gone; nobody else is waiting for it.
    void answerBrowserAgentOpen(request).catch((error: unknown) => console.error('Failed to answer the agent browser request:', error))
  }), [])
}
