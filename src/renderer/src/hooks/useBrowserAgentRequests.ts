import { useEffect } from 'react'
import type { BrowserAgentOpenRequest } from '../../../shared/browser'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'
import { useSessionsStore } from '../stores/sessions'

/** Browser tab-strip changes are applied only in the requesting session's own UI window. */
export async function answerBrowserAgentOpen(request: BrowserAgentOpenRequest): Promise<void> {
  const { requestId, sessionId } = request
  const store = useSessionsStore.getState()
  const session = store.openTabs.find((tab) => tab.id === sessionId && (tab.kind === 'project' || tab.kind === 'chat'))
  let result: { browserId: string } | { error: string }
  try {
    if (!session && request.action !== 'close') throw new Error('The session is not open in this window')
    if (request.action === 'activate' || request.action === 'close') {
      const browser = store.openTabs.find((tab) => tab.id === request.browserId && tab.kind === 'browser')
      if (request.action === 'activate') {
        if (!browser) throw new Error('The browser tab is no longer open')
        await store.activateTab(browser.id)
      } else if (browser) {
        store.closeTab(browser.id)
      }
      result = { browserId: request.browserId }
    } else {
      result = { browserId: await store.openBrowserTab(session!.kind === 'chat' ? null : session!.cwd, { background: true, targetSessionId: sessionId }) }
    }
  } catch (error) {
    // The agent's tool call is the one waiting: the failure goes back to it as the answer.
    result = { error: failureMessage(error) }
  }
  await api.browser.answerAgentOpen(requestId, result)
}

/** Main requests open, activation or close; tabs are UI state, so the strip acknowledges each change. */
export function useBrowserAgentRequests(): void {
  useEffect(() => api.browser.onAgentOpenRequest((request) => {
    // A failed answer means the window or request is gone; nobody else is waiting for it.
    void answerBrowserAgentOpen(request).catch((error: unknown) => console.error('Failed to answer the agent browser request:', error))
  }), [])
}
