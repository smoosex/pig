import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // Exercise queue identity, not happy-dom's incomplete native animation lifecycle.
  Reflect.deleteProperty(Element.prototype, 'animate')
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const { mock } = await import('bun:test')
  const { create } = await import('zustand')
  const actions: Array<{ index: number; action: string; mode?: string }> = []
  type Queues = { steeringMessages: string[]; followUpMessages: string[] }
  const store = create<{
    runtime: Record<string, Queues>
    queueFollowUpAction: (id: string, index: number, action: string, mode?: string) => Promise<void>
  }>(() => ({
    runtime: { session: { steeringMessages: ['直接插话'], followUpMessages: ['追加任务'] } },
    queueFollowUpAction: async (_id, index, action, mode) => {
      actions.push({ index, action, mode })
      if (action === 'steer') store.setState({ runtime: {
        session: { steeringMessages: ['直接插话', '追加任务'], followUpMessages: [] }
      } })
    }
  }))
  mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: store }))
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { FollowUpQueue } = await import('../src/renderer/src/components/FollowUpQueue')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(createElement(FollowUpQueue, { sessionId: 'session' })) })
    const rows = () => [...container.querySelectorAll('li[data-queue-mode][aria-hidden="false"]')]
    assert.equal(rows().length, 2)
    assert.match(rows()[0].textContent ?? '', /待插入.*直接插话/)
    assert.match(rows()[1].textContent ?? '', /本轮结束后.*追加任务/)
    const followUp = rows()[1]
    const id = followUp.getAttribute('data-queue-id')!
    await act(async () => {
      followUp.querySelector('button[aria-label="插话"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(actions, [{ index: 0, action: 'steer', mode: 'followUp' }])
    assert.equal(rows().length, 2, 'promotion does not make the message disappear')
    const promoted = container.querySelector(`li[data-queue-id="${id}"]`)!
    assert.equal(promoted, followUp, 'the same row remains mounted while its status changes')
    assert.equal(promoted.getAttribute('data-queue-mode'), 'steer')
    assert.match(promoted.textContent ?? '', /待插入.*追加任务/)
    assert.equal(promoted.querySelector('button[aria-label="插话"]'), null)
    await act(async () => {
      promoted.querySelector('button[aria-label="编辑"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(actions.at(-1), { index: 1, action: 'edit', mode: 'steer' })
    await act(async () => {
      store.setState({ runtime: { session: { steeringMessages: [], followUpMessages: [] } } })
    })
    assert.equal(rows().length, 0, 'a consumed message is no longer shown as pending')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--pending-message-queue-fixture') {
  await fixture()
} else {
  test('pending queue shows delivery modes, keeps promoted rows mounted, and routes steering edits', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--pending-message-queue-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}
