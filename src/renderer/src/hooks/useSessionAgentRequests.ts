/** Main owns session creation and persistence; this window only attaches background tabs. */
import { useEffect } from 'react'
import type { SessionAgentUiAnswer, SessionAgentUiRequest } from '../../../shared/session-agent'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'
import { useSessionsStore } from '../stores/sessions'

const createdTabs = new Map<string, number>()

export async function answerSessionAgentRequest(request: SessionAgentUiRequest): Promise<void> {
  const current = useSessionsStore.getState()
  for (const [id, instance] of createdTabs) if (current.runtime[id]?.instanceId !== instance) createdTabs.delete(id)
  // Main may retract a newly created tab after its caller disappears, even after an accepted ack.
  // Match the original runtime instance so a user-reopened tab is never closed by a late cleanup.
  if (request.action === 'remove') {
    if (createdTabs.get(request.sessionId) === current.runtime[request.sessionId]?.instanceId && createdTabs.has(request.sessionId)) {
      current.closeTab(request.sessionId, { confirmed: true })
    }
    createdTabs.delete(request.sessionId)
    return
  }
  let attached: { id: string; instanceId: number } | undefined
  const requireOpen = (id: string): void => {
    if (!useSessionsStore.getState().openTabs.some((tab) => tab.id === id && (tab.kind === 'project' || tab.kind === 'chat'))) {
      throw new Error('The session is not open in this window')
    }
  }
  const cleanup = (): void => {
    const state = useSessionsStore.getState()
    // A user may have closed and reopened this ID while the request was pending.
    if (attached && state.runtime[attached.id]?.instanceId === attached.instanceId) {
      state.closeTab(attached.id, { confirmed: true })
    }
    attached = undefined
  }
  let answer: SessionAgentUiAnswer
  try {
    requireOpen(request.callerSessionId)
    if (request.action === 'remove-project') {
      const cwds = new Set(request.cwds)
      if (useSessionsStore.getState().openTabs.some(tab => cwds.has(tab.cwd) && ['file', 'browser', 'terminal'].includes(tab.kind))) {
        throw new Error('Close the project’s file, browser and terminal tabs manually before removing it')
      }
      if (request.phase === 'apply') useSessionsStore.getState().forgetAgentProject(request.cwd, request.cwds)
    } else if (request.action === 'refresh') {
      requireOpen(request.sessionId)
      if (!useSessionsStore.getState().runtime[request.sessionId]) throw new Error('Session runtime is not ready')
      await useSessionsStore.getState().loadControls(request.sessionId)
      requireOpen(request.sessionId)
    } else {
      useSessionsStore.getState().mergeAgentProject(request.project)
      if (request.action === 'create') {
        const state = useSessionsStore.getState()
        const existed = state.openTabs.some((tab) => tab.id === request.session.sessionId)
        // attachAgentSession adds the tab synchronously, before its controls read can yield.
        const readiness = state.attachAgentSession(request.session, request.session.title)
        const runtime = useSessionsStore.getState().runtime[request.session.sessionId]
        if (!existed && runtime && useSessionsStore.getState().openTabs.some((tab) => tab.id === request.session.sessionId)) {
          attached = { id: request.session.sessionId, instanceId: runtime.instanceId }
          createdTabs.set(attached.id, attached.instanceId)
        }
        await readiness
        requireOpen(request.session.sessionId)
        if (attached && useSessionsStore.getState().runtime[attached.id]?.instanceId !== attached.instanceId) {
          throw new Error('Session replaced during attachment')
        }
      }
    }
    requireOpen(request.callerSessionId)
    answer = { ok: true }
  } catch (error) {
    cleanup()
    answer = { error: failureMessage(error) }
  }
  try {
    await api.sessionAgent.answer(request.requestId, answer)
  } catch (error) {
    cleanup()
    throw error
  }
}

export function useSessionAgentRequests(): void {
  useEffect(() => api.sessionAgent.onRequest((request) => {
    void answerSessionAgentRequest(request).catch((error: unknown) => console.error('Failed to answer the agent session request:', error))
  }), [])
}
