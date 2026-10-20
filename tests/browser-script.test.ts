import { expect, test } from 'bun:test'
import type { WebContents } from 'electron'
import { executeBrowserScript } from '../src/main/browser/browser-script'

const electronBoundary = {
  async executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>) {
    expect(world).toBe(1207)
    // Electron intentionally exposes only a generic rejection for uncaught page exceptions.
    try { return await new Function(`return ${scripts[0]!.code}`)() }
    catch { throw new Error('Script failed to execute') }
  }
} as unknown as WebContents

test('isolated script results preserve data, false and undefined', async () => {
  expect(await executeBrowserScript(electronBoundary, 1207, '({ text: "page", refs: 3 })')).toEqual({ text: 'page', refs: 3 })
  expect(await executeBrowserScript(electronBoundary, 1207, 'false')).toBe(false)
  expect(await executeBrowserScript(electronBoundary, 1207, 'undefined')).toBeUndefined()
})

test('script exceptions and async rejections retain their messages across the Electron boundary', async () => {
  await expect(executeBrowserScript(electronBoundary, 1207, '(() => { throw new Error("Unknown browser ref; take a new browser_snapshot") })()'))
    .rejects.toThrow('Unknown browser ref; take a new browser_snapshot')
  await expect(executeBrowserScript(electronBoundary, 1207, 'Promise.reject(new Error("Invalid selector"))')).rejects.toThrow('Invalid selector')
  await expect(executeBrowserScript(electronBoundary, 1207, '(() => { throw "Non-Error failure" })()')).rejects.toThrow('Non-Error failure')
})

test('Electron transport and lifecycle rejections are propagated unchanged', async () => {
  const failure = new Error('Execution context was destroyed')
  const contents = { executeJavaScriptInIsolatedWorld: async () => { throw failure } } as unknown as WebContents
  await expect(executeBrowserScript(contents, 1207, 'true')).rejects.toBe(failure)
})

test('invalid script envelopes fail loudly instead of becoming successful empty results', async () => {
  for (const result of [null, {}, { ok: true }, { ok: 'true', value: 1 }, { ok: false, error: {} }]) {
    const contents = { executeJavaScriptInIsolatedWorld: async () => result } as unknown as WebContents
    await expect(executeBrowserScript(contents, 1207, 'true')).rejects.toThrow('Invalid browser script result')
  }
})
