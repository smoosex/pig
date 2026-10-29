/**
 * Runs a child as an in-process SDK session persisted under the parent's subagent directory.
 *
 * Children have no ordinary extension UI or Pig system UI. Permission requests alone can be
 * forwarded to the parent. Prompts are sent without template or command expansion, so a task
 * starting with `/` stays plain text.
 */
import { SessionManager, type AgentSession, type ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { isChatCwd } from '../chats'
import { enabledPluginPaths, subagentPluginPaths } from '../pi/plugins'
import { synchronizeModelCatalog } from '../pi/model-catalog'
import { startModelRuntime } from '../pi/model-settings'
import { createSessionRuntime } from '../pi/session-runtime'
import { applySessionTools, readSessionCapabilities } from '../pi/session-capabilities'
import { SUBAGENT_SYSTEM_PROMPT } from '../plugins/pig-subagent/prompts'
import { worktrees } from '../project-worktrees'
import { sessionPermission } from '../permissions/store'
import type { RunEvent, RunResult, RunSpec, SubagentRun, SubagentRunner } from './runner'

type Content = { type: string; text?: string }
type AssistantLike = {
  role: 'assistant'
  content: Content[]
  stopReason?: string
  errorMessage?: string
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
}

function text(message: AssistantLike): string {
  return message.content.filter((block) => block.type === 'text' && block.text).map((block) => block.text).join('\n')
}

function lastAssistant(messages: readonly unknown[]): AssistantLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string }
    if (message?.role === 'assistant') return message as AssistantLike
  }
  return undefined
}

async function shutdown(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch {
  }
  session.dispose()
  synchronizeModelCatalog()
}

export function createSdkRunner(approvalUI?: (spec: RunSpec) => Pick<ExtensionUIContext, 'select'>): SubagentRunner {
  return {
    async start(spec: RunSpec, onEvent: (event: RunEvent) => void): Promise<SubagentRun> {
      spec.signal?.throwIfAborted()
      worktrees.assertAvailable(spec.cwd)
      const sessionManager = SessionManager.create(spec.cwd, spec.sessionDir)
      const pluginPaths = subagentPluginPaths(await enabledPluginPaths(isChatCwd(spec.cwd) ? 'chat' : 'project'))
      spec.signal?.throwIfAborted()
      // Snapshot at launch: later parent edits must not mutate a running child's capabilities.
      const parentPreferences = readSessionCapabilities(spec.parentSessionId)
      const toolPreferences = { tools: { ...parentPreferences.tools, spawn: false }, mcp: { ...parentPreferences.mcp } }
      const permissions = { sessionId: spec.parentSessionId, mode: sessionPermission(spec.parentSessionId).mode, approvalUI: approvalUI?.(spec), signal: spec.signal }
      const session = await createSessionRuntime(spec.cwd, sessionManager, pluginPaths, [SUBAGENT_SYSTEM_PROMPT], { toolPreferences, identity: false, permissions })
      let aborted = false
      const abort = () => {
        aborted = true
        void session.abort().catch(() => {})
      }
      spec.signal?.addEventListener('abort', abort, { once: true })
      try {
        spec.signal?.throwIfAborted()
        await session.bindExtensions({
          mode: 'print',
          onError: (error) => console.warn(`Subagent extension error ${error.extensionPath}: ${error.error}`)
        })
        await applySessionTools(session, toolPreferences.tools, true)
        if (spec.model) {
          const model = (await startModelRuntime()).getModel(spec.model.provider, spec.model.id)
          if (!model) throw new Error(`Model not found: ${spec.model.provider}/${spec.model.id}`)
          await session.setModel(model)
        }
        if (spec.thinkingLevel) session.setThinkingLevel(spec.thinkingLevel)
        spec.signal?.throwIfAborted()
      } catch (error) {
        spec.signal?.removeEventListener('abort', abort)
        await shutdown(session)
        throw error
      }

      const unsubscribe = session.subscribe((event) => {
        if ('parentToolCallId' in event && event.parentToolCallId) return
        if (event.type === 'turn_start') onEvent({ type: 'turn_start' })
        else if (event.type === 'tool_execution_start') {
          const args = event.args && typeof event.args === 'object' && !Array.isArray(event.args) ? event.args as Record<string, unknown> : {}
          onEvent({ type: 'tool', name: event.toolName, args })
        } else if (event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant') {
          const message = event.message as unknown as AssistantLike
          const usage = message.usage ?? {}
          onEvent({
            type: 'assistant',
            text: text(message),
            thinking: message.content.some((block) => block.type === 'thinking'),
            input: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
            output: usage.output ?? 0,
            cost: usage.cost?.total ?? 0
          })
        }
      })

      const done = (async (): Promise<RunResult> => {
        try {
          await session.prompt(spec.prompt, { expandPromptTemplates: false, source: 'extension' })
          await session.waitForIdle()
          const last = lastAssistant(session.messages)
          if (!aborted && last?.stopReason === 'error') return { error: last.errorMessage || 'The model request failed' }
          return {}
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        } finally {
          spec.signal?.removeEventListener('abort', abort)
          unsubscribe()
          await shutdown(session)
        }
      })()

      return {
        sessionFile: sessionManager.getSessionFile(),
        done,
        abort,
        messages: () => [...session.messages]
      }
    },

    async readTranscript(sessionFile: string): Promise<unknown[]> {
      try {
        return SessionManager.open(sessionFile).buildSessionContext().messages
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    }
  }
}
