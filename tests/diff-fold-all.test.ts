/**
 * The fold-all control in the changes toolbar: its icon names the action it will take, so the
 * expanded and collapsed states must render different icons. A rotated ChevronsDownUp reads the
 * same either way — the glyph is symmetric under a half turn — which is what this pins.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

const CWD = '/fold-project'

const diff = {
  git: true,
  staged: [],
  unstaged: [
    { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
    { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0 }
  ],
  all: [
    { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
    { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0 }
  ]
}

test('the fold-all button swaps its icon with its action', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  try {
    GlobalRegistrator.register({ url: 'http://localhost' })
  } catch {
    // One registration per process; other fixtures may have taken it already.
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: Object.assign(() => null, { getState: () => ({}) })
  }))
  Object.defineProperty(window, 'api', {
    value: {
      readWorktreeDiff: async () => diff,
      readWorktreePatch: async () => ({ git: true, patch: '', truncated: false }),
      readUntrackedFile: async () => ({ kind: 'text', contents: '', lines: 0 }),
      watchWorktreeDiff: async () => 'lease',
      unwatchWorktreeDiff: async () => {},
      onDiffChanged: () => () => {},
      onDiffWatchError: () => () => {}
    },
    configurable: true
  })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { ChangesView } = await import('../src/renderer/src/components/diff/ChangesView')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(ChangesView, { cwd: CWD })) })
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }

  const control = () =>
    container.querySelector('button[aria-label="折叠全部"], button[aria-label="展开全部"]') as HTMLElement | null
  const iconName = () =>
    control()?.querySelector('svg')?.classList.contains('lucide-chevrons-up-down')
      ? 'unfold'
      : 'fold'
  const cardStates = () =>
    [...container.querySelectorAll('section[id^="diff-section:"]')].map(
      (card) => card.querySelector('button')?.getAttribute('aria-expanded')
    )
  const click = async () => {
    const target = control()
    assert.ok(target)
    await act(async () => {
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
  }

  assert.equal(control()?.getAttribute('aria-label'), '展开全部')
  assert.equal(iconName(), 'unfold')
  await click()
  assert.equal(control()?.getAttribute('aria-label'), '折叠全部')
  assert.equal(iconName(), 'fold')
  assert.deepEqual(cardStates(), ['true', 'true'])
  await click()
  assert.equal(control()?.getAttribute('aria-label'), '展开全部')
  assert.equal(iconName(), 'unfold')
  assert.deepEqual(cardStates(), ['false', 'false'])
  await act(async () => { root.unmount() })
})
