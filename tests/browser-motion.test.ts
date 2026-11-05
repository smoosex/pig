import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import { browserMotionState, waitForBrowserMotion } from '../src/main/browser/browser-motion'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  try {
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<div><button>Target</button></div>'
    const container = root.querySelector('div')!
    const button = root.querySelector('button')!
    document.elementFromPoint = () => host
    root.elementFromPoint = () => button
    const sample = (point?: { x: number; y: number }) => new Function(`return (${browserMotionState.toString()})(${JSON.stringify(point) ?? ''})`)() as string
    const initial = sample({ x: 10, y: 20 })
    container.scrollTop = 30
    // No composed scroll event: ancestor offsets must detect shadow-root scrolling themselves.
    assert.notEqual(sample(), initial)
    const scrolled = sample()
    document.dispatchEvent(new Event('scroll'))
    assert.notEqual(sample(), scrolled)
  } finally { await GlobalRegistrator.unregister() }
}

if (process.argv[2] === '--motion-fixture') {
  await fixture()
} else {
  test('serialized motion monitoring detects nested and open-shadow-root scrolling', async () => {
    const result = await runSelf(import.meta.path, ['--motion-fixture'])
    expect(result.exitCode, result.stderr || result.stdout).toBe(0)
  })

  test('motion waiting stops on cancellation and rejects malformed samples', async () => {
    let reads = 0
    let cancelled = false
    const contents = {
      executeJavaScriptInIsolatedWorld: async () => { reads++; cancelled = true; return { ok: true, value: 'stable' } }
    } as unknown as WebContents
    await expect(waitForBrowserMotion(contents, () => { if (cancelled) throw new Error('cancelled') })).rejects.toThrow('cancelled')
    expect(reads).toBe(1)
    contents.executeJavaScriptInIsolatedWorld = async () => ({ ok: true, value: {} })
    await expect(waitForBrowserMotion(contents, () => {})).rejects.toThrow('Invalid browser motion state')
  })

  test('continuously moving pages time out instead of reporting a settled scroll', async () => {
    let revision = 0
    const contents = {
      executeJavaScriptInIsolatedWorld: async () => ({ ok: true, value: String(revision++) })
    } as unknown as WebContents
    await expect(waitForBrowserMotion(contents, () => {})).rejects.toThrow('did not settle')
  })
}
