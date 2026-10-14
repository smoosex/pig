import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { Turn } from '../src/renderer/src/chat/turns'

/** Standalone command cards render the SDK's bashExecution message, not the model's bash tool. */
async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/lib/highlight', () => ({
    langFromPath: () => 'plaintext',
    useHighlightHtml: (code: string) => `<pre><code>${code}</code></pre>`
  }))
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { TurnView } = await import('../src/renderer/src/components/TurnView')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const command = 'echo ready'
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  const message = {
    role: 'bashExecution' as const, command, output: 'ready\n', exitCode: 0,
    cancelled: false, truncated: false, timestamp: 1
  }
  const turn: Turn = {
    id: 'command-1', bash: { command, exitCode: 0, cancelled: false },
    user: undefined, process: [], answer: [], startedAt: 1, endedAt: 2,
    streaming: false, waitingForModel: false, hasProcess: true
  }
  let loads = 0
  let stops = 0
  let release: (() => void) | null = null
  let defer = false
  try {
    await act(async () => { root.render(createElement(TurnView, {
      turn,
      onNeedProcess: async () => {
        loads++
        if (defer) await new Promise<void>((resolve) => { release = resolve })
        turn.process = [{ kind: 'bash', message }]
      },
      onAbortBash: async () => { stops++ }
    })) })
    assert.equal(container.textContent?.includes('$ echo ready'), true)
    assert.equal(container.textContent?.includes('Exit code 0'), true)
    assert.ok(container.querySelector('[data-slot="card"]'))
    assert.ok(container.querySelector('[data-slot="badge"].bg-success-background'))
    assert.equal(container.textContent?.includes('Worked for'), false)
    const header = container.querySelector('[data-slot="card-header"]')!
    const items = [...header.children]
    assert.equal(items[0]?.getAttribute('aria-label'), 'Show output')
    assert.equal(items.at(-1)?.getAttribute('aria-label'), 'Show output')
    assert.equal(items.at(-2)?.getAttribute('data-slot'), 'badge')
    defer = true
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Show output"]')!.click() })
    assert.equal(loads, 1)
    // The card opens before the history read resolves, so the click has feedback and the loader shows.
    assert.equal(container.querySelector('[data-slot="collapsible-trigger"][aria-expanded="false"]'), null)
    assert.equal(container.querySelector('pre.whitespace-pre-wrap')?.textContent, 'Loading…')
    await act(async () => { release?.(); await Bun.sleep(0) })
    await act(async () => { root.render(createElement(TurnView, { turn })) })
    assert.equal(container.querySelector('pre.whitespace-pre-wrap')?.textContent, 'ready\n')
    assert.equal(container.querySelectorAll('[data-slot="card-content"]').length, 2)
    assert.equal(container.querySelectorAll('[data-slot="separator"][data-orientation="horizontal"]').length, 2)
    assert.ok(container.querySelector('.bg-secondary'))
    assert.ok(container.querySelector('[data-slot="card-content"] .bg-code-background'))
    assert.ok(container.querySelector('[aria-label="Copy command"]'))
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click() })
    assert.deepEqual(copied, ['ready\n'])
    const acknowledged = container.querySelector<HTMLButtonElement>('[aria-label="Copied"]')!
    assert.ok(acknowledged.classList.contains('text-success'))
    assert.ok(acknowledged.querySelector('.lucide-check'))
    await act(async () => { await Bun.sleep(1600) })
    assert.ok(container.querySelector('[aria-label="Copy output"]'))
    assert.equal(container.querySelector('[aria-label="Copied"]'), null)

    const live: Turn = {
      ...turn, id: 'live:bash:run-1', bash: { command, cancelled: false },
      bashRunning: true, process: [{ kind: 'bash', message: { ...message, output: 'partial', exitCode: undefined } }]
    }
    await act(async () => { root.render(createElement(TurnView, {
      turn: live, onAbortBash: async () => { stops++ }
    })) })
    assert.equal(container.textContent?.includes('Running'), true)
    assert.equal(container.querySelector('pre.whitespace-pre-wrap')?.textContent, 'partial')
    assert.equal([...container.querySelector('[data-slot="card-header"]')!.children].at(-2)?.getAttribute('aria-label'), 'Stop command')
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Stop command"]')!.click() })
    assert.equal(stops, 1)

    const failed: Turn = {
      ...turn, id: 'command-2', bash: { command, exitCode: 1, cancelled: false },
      process: [{ kind: 'bash', message: { ...message, output: 'boom', exitCode: 1 } }]
    }
    await act(async () => { root.render(createElement(TurnView, { turn: failed })) })
    assert.equal(container.textContent?.includes('Exit code 1'), true)
    assert.ok(container.querySelector('[data-slot="badge"].bg-destructive-background'))
    assert.equal(container.innerHTML.includes('bg-destructive/'), false)

    // A collapsed card must reveal a failed stop instead of hiding its error.
    const failing: Turn = {
      ...live,
      process: [{ kind: 'bash', message: { ...message, output: 'partial', exitCode: undefined } }]
    }
    await act(async () => { root.render(createElement(TurnView, {
      turn: failing, onAbortBash: async () => { throw new Error('abort failed') }
    })) })
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('[aria-label="Hide output"]')[1]!.click() })
    assert.ok(container.querySelector('[data-slot="collapsible-trigger"][aria-expanded="false"]'))
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Stop command"]')!.click() })
    assert.equal(container.textContent?.includes('abort failed'), true)
    assert.equal(container.querySelector('[data-slot="collapsible-trigger"][aria-expanded="false"]'), null)

    // A command can head a turn that carries other entries; the card must not swallow them.
    const mixed: Turn = {
      ...turn, id: 'command-1', process: [{ kind: 'bash', message }],
      branchSummaries: [{ text: 'summarized', afterAnswer: true, compactionsBefore: 0 }], answer: [{ type: 'text', text: 'later' }]
    }
    await act(async () => { root.render(createElement(TurnView, { turn: mixed })) })
    assert.equal(container.textContent?.includes('$ echo ready'), true)
    assert.equal(container.textContent?.includes('ready\n'), true)
    assert.equal(container.textContent?.includes('later'), true)
    assert.equal(container.textContent?.includes('Worked for'), false)
    const summary = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Branch summary'))
    assert.ok(summary)
    assert.equal(summary.closest('[data-slot="collapsible-content"]'), null)
    await act(async () => { summary.click(); await Bun.sleep(0) })
    assert.equal(container.textContent?.includes('summarized'), true)
    assert.equal(container.querySelectorAll('[data-slot="card"]').length, 1)
    await act(async () => { root.render(createElement(TurnView, { turn: { ...mixed, answer: [] } })) })
    assert.equal(container.textContent?.includes('Branch summary'), true)
    assert.equal(container.textContent?.includes('Worked for'), false)

    const failedTurn: Turn = { ...turn, id: 'command-1', errorMessage: 'model exploded' }
    await act(async () => { root.render(createElement(TurnView, { turn: failedTurn })) })
    assert.equal(container.textContent?.includes('model exploded'), true)
    assert.equal(container.textContent?.includes('Worked for'), false)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--bash-turn-fixture') {
  await fixture()
} else {
  test('standalone commands reveal persisted output and can stop a running command', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--bash-turn-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}
