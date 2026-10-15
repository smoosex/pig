/**
 * One-shot provider test for the web access settings page.
 *
 * The extension only exposes its search through registered tools, and tools run against a session,
 * so the test spins up a throwaway in-memory session in a scratch directory with Pig's plugins
 * loaded and runs the real web_search tool through the SDK's extension wrapper. No conversation,
 * window, or open project is involved: the plugin reads its config from the Pig directory.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, SessionManager, wrapRegisteredTool } from '@earendil-works/pi-coding-agent'
import type { WebSearchTestResult } from '../../shared/api'
import { createNoExtensionsResourceLoader } from './chat-resources'
import { enabledPluginPaths } from './plugins'
import { webSearchToolName } from './web-search-settings'

const TEST_QUERY = 'pi coding agent'

async function withTestSession<T>(fn: (session: Awaited<ReturnType<typeof createAgentSession>>['session']) => Promise<T>): Promise<T> {
  let cwd: string | null = null
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null
  try {
    // A fresh directory per run, so concurrent tests never share a working directory.
    cwd = await mkdtemp(join(tmpdir(), 'pig-web-search-test-'))
    const resourceLoader = await createNoExtensionsResourceLoader(cwd, await enabledPluginPaths('any'))
    const extensionErrors = resourceLoader.getExtensions().errors
    if (extensionErrors.length) {
      throw new Error(extensionErrors.map((item) => `${item.path}: ${item.error}`).join('\n'))
    }
    // The session's own runtime is enough: search providers that need a model read it from the
    // registry, and skipping Pig's shared runtime avoids its provider refresh for a throwaway session.
    const created = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader
    })
    session = created.session
    await session.bindExtensions({ mode: 'rpc' })
    return await fn(session)
  } finally {
    session?.dispose()
    if (cwd) await rm(cwd, { recursive: true, force: true })
  }
}

export async function testWebSearchProvider(provider: string | null): Promise<WebSearchTestResult> {
  try {
    return await withTestSession(async (session) => {
      const toolName = await webSearchToolName()
      const runner = session.extensionRunner
      const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === toolName)
      if (!registered) throw new Error(`${toolName} is not registered; enable Pi Web Access and retry`)
      const tool = wrapRegisteredTool(registered, runner)
      const result = await tool.execute('pig-web-search-test', {
        query: TEST_QUERY,
        numResults: 3,
        ...(provider ? { provider } : {})
      })
      const text = (result.content ?? [])
        .map((item) => (item.type === 'text' ? item.text : ''))
        .filter((item) => item.length > 0)
        .join('\n')
      // web_search turns per-query failures (missing key, auth, provider errors) into ordinary
      // tool results, so the structured details decide success; the text alone always looks fine.
      const details = result.details as { successfulQueries?: unknown; error?: unknown } | undefined
      if (details && typeof details.error === 'string' && details.error) {
        return { ok: false, message: text || details.error }
      }
      if (details && typeof details.successfulQueries === 'number' && details.successfulQueries === 0) {
        return { ok: false, message: text || 'Search failed before returning any result' }
      }
      return { ok: true, message: text || 'Search returned no text output' }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
