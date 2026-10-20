/** Electron replaces isolated-world exceptions with a generic rejection. Carry script failures as
 * data across that boundary, then rethrow in main; transport/lifecycle rejections stay untouched. */
import type { WebContents } from 'electron'

export async function executeBrowserScript<T>(contents: WebContents, world: number, code: string): Promise<T> {
  const result: unknown = await contents.executeJavaScriptInIsolatedWorld(world, [{
    code: `(async () => {
      try { return { ok: true, value: await (${code}) }; }
      catch (error) { return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }; }
    })()`
  }])
  if (!result || typeof result !== 'object' || !('ok' in result)) throw new Error('Invalid browser script result')
  if (result.ok === true && 'value' in result) return result.value as T
  if (result.ok === false && 'error' in result && result.error && typeof result.error === 'object'
    && 'message' in result.error && typeof result.error.message === 'string') throw new Error(result.error.message)
  throw new Error('Invalid browser script result')
}
