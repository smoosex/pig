import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { Turn } from '../src/renderer/src/chat/turns'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TurnMinimap } = await import('../src/renderer/src/components/chat/TurnMinimap')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const items: Turn[] = [
    { user: { role: 'user', content: '第一条问题', timestamp: 0 } },
    { user: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }], timestamp: 0 } },
    { answer: [{ type: 'text', text: '模型的回复' }] }
  ].map((item, index) => ({
    id: String(index), process: [], answer: [], startedAt: 0, endedAt: 1, streaming: false, ...item
  }))
  const jumps: number[] = []
  try {
    await act(async () => { root.render(createElement(TurnMinimap, { items, onJump: (index) => jumps.push(index) })) })
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    assert.equal(buttons.length, 3)
    assert.equal(buttons[0].getAttribute('aria-label'), '第 1 轮：第一条问题')
    assert.equal(buttons[1].getAttribute('aria-label'), '第 2 轮：图片消息')
    assert.equal(buttons[2].getAttribute('aria-label'), '第 3 轮：模型的回复')
    assert.equal(buttons.filter((button) => button.tabIndex === 0).length, 1)
    await act(async () => {
      buttons[0].focus()
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    assert.equal(document.activeElement, buttons[1])
    assert.equal(buttons[1].tabIndex, 0)
    await act(async () => { buttons[1].click() })
    assert.deepEqual(jumps, [1])
    await act(async () => { buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    assert.equal(document.activeElement, buttons[2])
    await act(async () => { buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    assert.equal(document.activeElement, buttons[1])
    await act(async () => { buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    assert.equal(document.activeElement, buttons[0])
    await act(async () => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    assert.equal(document.activeElement, buttons[0])
    const navigation = container.querySelector('[role="navigation"]')!
    await act(async () => { navigation.dispatchEvent(new MouseEvent('click', { clientY: 29, bubbles: true })) })
    assert.deepEqual(jumps, [1, 2])
    await act(async () => { buttons[2].focus() })
    await act(async () => { root.render(createElement(TurnMinimap, { items: items.slice(0, 1), onJump: (index) => jumps.push(index) })) })
    assert.equal(container.querySelector<HTMLButtonElement>('button')?.tabIndex, 0)
    await act(async () => { root.render(createElement(TurnMinimap, { items: [], onJump: (index) => jumps.push(index) })) })
    assert.equal(container.childElementCount, 0)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--minimap-fixture') {
  await fixture()
} else {
  test('turn minimap supports keyboard navigation and activates the exact turn once', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--minimap-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}
