import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const reads: Array<{ id: string; kind: string; full?: boolean }> = []
  Object.assign(window, { api: {
    getMemoryDetail: async (id: string, kind: string, full?: boolean) => {
      reads.push({ id, kind, full })
      return kind === 'status' ? '── Memory ──\nObservations: 1' : full ? 'Full memory' : 'Visible memory'
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
  const props = { sessionId: 'draft', memoryAvailable: true, usage: null, tokens: null, onOpen: () => {} }
  const button = (name: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === name || item.getAttribute('aria-label') === name
    )
    assert.ok(found, `missing button: ${name}`)
    return found
  }
  const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 15)) }) }
  try {
    await act(async () => { root.render(h(TooltipProvider, null, h(ContextUsageButton, props))) })
    await act(async () => { button('上下文窗口').click() })
    await flush()
    assert.ok(document.querySelector('[data-slot="popover-content"]'))
    await act(async () => { button('查看记忆').click() })
    await flush()
    assert.ok(document.querySelector('[data-slot="dialog-content"]'))
    assert.ok(document.body.textContent?.includes('Visible memory'))
    await act(async () => { button('完整记录').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('Full memory'))
    assert.deepEqual(reads.map(({ kind, full }) => [kind, full]), [['view', false], ['view', true]])
    await act(async () => { button('Close').click() })
    await flush()
    await act(async () => { button('上下文窗口').click() })
    await flush()
    await act(async () => { button('记忆状态').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('Observations: 1'))
    await act(async () => { root.render(h(TooltipProvider, null, h(ContextUsageButton, { ...props, memoryAvailable: false }))) })
    await flush()
    assert.equal(document.querySelector('[data-slot="dialog-content"]'), null)
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--context-memory-fixture')) {
  await fixture()
} else {
  test('memory actions in the context popover open dialogs with visible and full views', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--context-memory-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer); child.kill() }
  }, 14_000)
}
