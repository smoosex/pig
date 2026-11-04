/** One bounded search through the same adapters as the Agent, without creating a model session. */
import type { WebSearchTestResult } from '../../shared/api'
import { searchProvider } from '../plugins/pig-web/config'
import { searchWeb } from '../plugins/pig-web/search'

export async function testWebSearchProvider(provider: string | null): Promise<WebSearchTestResult> {
  try {
    const result = await searchWeb(['pi coding agent'], 3, AbortSignal.timeout(30_000), provider === null ? undefined : searchProvider(provider))
    return { ok: true, message: `${result.provider}: ${result.sources.length} results` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Search failed' }
  }
}
