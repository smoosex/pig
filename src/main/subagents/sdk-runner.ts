/**
 * Runs a child as an in-process SDK session persisted under the parent's subagent directory.
 *
 * Children get no window, no extension UI and no Pig system UI: nobody can answer a prompt, so
 * interactive extension calls resolve as cancelled. Prompts are sent without template or command
 * expansion, so a task starting with `/` stays plain text.
 */
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import { isChatCwd } from '../chats'
import { enabledPluginPaths, subagentPluginPaths } from '../pi/plugins'
import { synchronizeModelCatalog } from '../pi/model-catalog'
import { startModelRuntime } from '../pi/model-settings'
import { createSessionRuntime } from '../pi/session-runtime'
import { applySessionTools, readSessionCapabilities } from '../pi/session-capabilities'
import { SUBAGENT_SYSTEM_PROMPT } from '../plugins/pig-subagent/prompts'
import { worktrees } from '../project-worktrees'
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

export function createSdkRunner(): SubagentRunner {
  return {
    async start(spec: RunSpec, onEvent: (event: RunEvent) => void): Promise<SubagentRun> {
      worktrees.assertAvailable(spec.cwd)
      const sessionManager = SessionManager.create(spec.cwd, spec.sessionDir)
      const pluginPaths = subagentPluginPaths(await enabledPluginPaths(isChatCwd(spec.cwd) ? 'chat' : 'project'))
      // Snapshot at launch: later parent edits must not mutate a running child's capabilities.
      const parentPreferences = readSessionCapabilities(spec.parentSessionId)
      const toolPreferences = { tools: { ...parentPreferences.tools, spawn: false }, mcp: { ...parentPreferences.mcp } }
      const session = await createSessionRuntime(spec.cwd, sessionManager, pluginPaths, [SUBAGENT_SYSTEM_PROMPT], { toolPreferences, identity: false })
      try {
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
      } catch (error) {
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

      let aborted = false
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
          unsubscribe()
          await shutdown(session)
        }
      })()

      return {
        sessionFile: sessionManager.getSessionFile(),
        done,
        abort: () => {
          aborted = true
          void session.abort().catch(() => {})
        },
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
