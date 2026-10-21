/** Main authorizes terminal ownership; this window applies tab creation, activation and close. */
import { useEffect } from 'react'
import type { TerminalAgentOpenRequest, TerminalAgentOpenAnswer } from '../../../shared/terminal-agent'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'
import { useSessionsStore } from '../stores/sessions'

export async function answerTerminalAgentOpen(request: TerminalAgentOpenRequest): Promise<void> {
  const store = useSessionsStore.getState()
  const session = store.openTabs.find((tab) => tab.id === request.sessionId && (tab.kind === 'project' || tab.kind === 'chat'))
  let terminalId: string | undefined
  let result: TerminalAgentOpenAnswer
  try {
    if (!session && request.action !== 'close') throw new Error('The session is not open in this window')
    if (request.action === 'activate' || request.action === 'close') {
      const tab = store.openTabs.find((tab) => tab.id === request.terminalId && tab.kind === 'terminal')
      if (request.action === 'activate') {
        if (!tab) throw new Error('The terminal tab is no longer open')
        await store.activateTab(tab.id)
      } else if (tab) {
        store.closeTab(tab.id)
      }
      result = { terminalId: request.terminalId }
    } else {
      const cwd = session!.kind === 'chat' ? null : session!.cwd
      terminalId = store.openTerminalTab(cwd, { background: true })
      // Keep xterm lazy for windows that never use terminals, but start parsing/ACKing before answering.
      const { ensureTerminal } = await import('../terminal/runtime')
      if (!useSessionsStore.getState().openTabs.some((tab) => tab.id === terminalId)) throw new Error('Terminal tab closed')
      await ensureTerminal(terminalId, cwd)
      if (!useSessionsStore.getState().openTabs.some((tab) => tab.id === request.sessionId)) throw new Error('Session closed during terminal startup')
      result = { terminalId }
    }
  } catch (error) {
    if (terminalId) useSessionsStore.getState().closeTab(terminalId)
    terminalId = undefined
    result = { error: failureMessage(error) }
  }
  try {
    await api.terminal.answerAgentOpen(request.requestId, result)
  } catch (error) {
    // Rejected late answers (including cancellation) must not leave an unclaimed shell behind.
    if (terminalId) useSessionsStore.getState().closeTab(terminalId)
    throw error
  }
}

export function useTerminalAgentRequests(): void {
  useEffect(() => api.terminal.onAgentOpenRequest((request) => {
    void answerTerminalAgentOpen(request).catch((error: unknown) => console.error('Failed to answer the agent terminal request:', error))
  }), [])
}
