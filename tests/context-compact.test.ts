import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionContextUsage } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const calls: [string, string | undefined][] = []
  const settles: { resolve: () => void; reject: (error: Error) => void }[] = []
  const settle = () => settles.at(-1)!
  Object.assign(window, { api: {
    compactSession: (id: string, instructions?: string) => {
      calls.push([id, instructions])
      return new Promise<void>((resolve, reject) => { settles.push({ resolve, reject }) })
    }
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { ContextUsageButton } = await import('../src/renderer/src/components/composer/ContextUsageButton')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const usage: SessionContextUsage = { tokens: 250_000, contextWindow: 1_000_000, autoCompactAt: 983_616, percent: 25 }
  const props = { sessionId: 's1', memoryAvailable: false, usage, tokens: null, onOpen: () => {}, compactBlock: null as 'running' | 'navigating' | 'compacting' | null }
  const render = async (patch: Partial<typeof props> = {}) => {
    await act(async () => { root.render(h(TooltipProvider, null, h(ContextUsageButton, { ...props, ...patch }))) })
  }
  const button = (name: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === name || item.getAttribute('aria-label') === name
    )
    assert.ok(found, `missing button: ${name}`)
    return found
  }
  const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 15)) }) }
  try {
    await render()
    await act(async () => { button('上下文窗口').click() })
    await flush()
    const marker = document.querySelector<HTMLElement>('[data-auto-compact-marker]')!
    assert.ok(marker, 'the auto-compaction threshold is marked on the bar')
    assert.ok(Math.abs(parseFloat(marker.style.left) - 98.3616) < 1e-6, 'the marker sits at the threshold share of the window')
    assert.equal(marker.getAttribute('aria-label'), '约在 983.6k（98%）自动压缩')

    await act(async () => { button('压缩').click() })
    assert.deepEqual(calls, [['s1', undefined]], 'one click compacts without instructions')
    assert.equal(button('压缩中…').disabled, true, 'a running compaction cannot start twice')
    await act(async () => { settle().resolve() })
    await flush()
    assert.equal(button('压缩').disabled, false)

    await act(async () => { button('自定义压缩说明').click() })
    const input = document.querySelector<HTMLTextAreaElement>('textarea')!
    assert.equal(button('按说明压缩').disabled, true, 'instructions must not be empty')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  保留决定  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('按说明压缩').click() })
    assert.deepEqual(calls[1], ['s1', '保留决定'])
    await act(async () => { settle().reject(new Error('Session tree navigation is in progress')) })
    await flush()
    assert.equal(document.querySelector('[role="alert"]')?.textContent, '压缩失败：Session tree navigation is in progress')
    assert.equal(document.querySelector('textarea')?.value, '  保留决定  ', 'a refused start keeps the instructions')

    // The toolbar survives a tab switch: one session compacting must not block or clear another.
    await act(async () => { button('压缩').click() })
    const first = settle()
    await render({ sessionId: 's2' })
    assert.equal(button('压缩').disabled, false, 'another session can compact meanwhile')
    await act(async () => { button('压缩').click() })
    assert.deepEqual(calls.at(-1), ['s2', undefined])
    await act(async () => { first.resolve() })
    await flush()
    assert.equal(button('压缩中…').disabled, true, 'the first session finishing leaves the second busy')
    await act(async () => { settle().resolve() })
    await flush()
    await render()
    assert.equal(button('压缩').disabled, false)

    for (const compactBlock of ['running', 'navigating', 'compacting'] as const) {
      await render({ compactBlock })
      assert.equal(button(compactBlock === 'compacting' ? '压缩中…' : '压缩').disabled, true, `${compactBlock} blocks compaction`)
      assert.equal(document.querySelector('textarea'), null)
    }
    await render({ usage: { ...usage, tokens: null, percent: null } })
    assert.equal(button('压缩').disabled, true, 'nothing to compact without a known context')
    await render({ usage: { ...usage, autoCompactAt: null } })
    assert.equal(document.querySelector('[data-auto-compact-marker]'), null, 'no marker when auto-compaction is off')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--context-compact-fixture')) {
  await fixture()
} else {
  test('context popover compacts manually and marks the auto-compaction threshold', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--context-compact-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer); child.kill() }
  }, 14_000)
}
