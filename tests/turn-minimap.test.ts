import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'
import type { Turn } from '../src/renderer/src/chat/turns'
import { summaryMinimapItem, turnMinimapItem } from '../src/renderer/src/chat/minimap'

/** The labels this file spells out are the Chinese ones, so the translator is pinned to zh-CN. */
const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate('zh-CN', key, params)

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub })
  // The minimap virtualizes inside a scrollable navigation box; give it a measurable height.
  const navigationHeight = (element: HTMLElement) => element.getAttribute('role') === 'navigation' ? 100 : 0
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return navigationHeight(this) }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return 120 }
  })
  // Virtualizer measures the scroll viewport via client dimensions, not its border box.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return navigationHeight(this) }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return 120 }
  })
  HTMLElement.prototype.getBoundingClientRect = function () {
    const height = Number.parseFloat(this.style.height) || navigationHeight(this)
    const top = this.parentElement?.getAttribute('role') === 'navigation' ? 8 : 0
    return new DOMRect(0, top, 120, height)
  }
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TurnMinimap } = await import('../src/renderer/src/components/chat/TurnMinimap')
  const { MessageScrollerProvider } = await import('../src/renderer/src/components/ui/message-scroller')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rows: Partial<Turn>[] = [
    { user: { role: 'user', content: '第一条问题', timestamp: 0 } },
    { user: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }], timestamp: 0 } },
    { answer: [{ type: 'text', text: '模型的回复' }] }
  ]
  const turns: Turn[] = rows.map((item, index) => ({
    id: String(index), process: [], answer: [], startedAt: 0, endedAt: 1, streaming: false, waitingForModel: false, ...item
  }))
  // A row the renderer never loaded keeps its bar through the summary alone.
  const items = [
    ...turns.map((turn, index) => turnMinimapItem(turn, index, t)),
    summaryMinimapItem({ id: 'older', bytes: 20, hasImages: true }, 3, t)
  ]
  const jumps: number[] = []
  const renderMinimap = (nextItems: typeof items) => createElement(
    MessageScrollerProvider,
    null,
    createElement(TurnMinimap, {
      items: nextItems,
      sessionId: 's1',
      branchViewId: 'b1',
      indexTrusted: false,
      loadedPreview: () => ({
        question: '预览问题',
        answer: '预览回答',
        hasQuestionImage: false,
        hasAnswerImage: false,
        streaming: false,
        error: false
      }),
      onJump: (index) => jumps.push(index)
    })
  )
  try {
    await act(async () => { root.render(renderMinimap(items)) })
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    assert.equal(buttons.length, 4)
    assert.equal(buttons[0].getAttribute('aria-label'), '第 1 轮：第一条问题')
    assert.equal(buttons[1].getAttribute('aria-label'), '第 2 轮：图片消息')
    assert.equal(buttons[2].getAttribute('aria-label'), '第 3 轮：模型的回复')
    // A row that was never loaded still gets a bar, labelled from the summary alone.
    assert.equal(buttons[3].getAttribute('aria-label'), '第 4 轮：图片消息')
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
    assert.equal(document.activeElement, buttons[3])
    await act(async () => { buttons[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    assert.equal(document.activeElement, buttons[2])
    await act(async () => { buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    assert.equal(document.activeElement, buttons[0])
    await act(async () => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    assert.equal(document.activeElement, buttons[0])
    const navigation = container.querySelector('[role="navigation"]')!
    await act(async () => { navigation.dispatchEvent(new MouseEvent('click', { clientY: 29, bubbles: true })) })
    assert.deepEqual(jumps, [1, 2])
    await act(async () => { buttons[2].focus() })
    await act(async () => { root.render(renderMinimap(items.slice(0, 1))) })
    assert.equal(container.querySelector<HTMLButtonElement>('button')?.tabIndex, 0)
    await act(async () => { root.render(renderMinimap([])) })
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
