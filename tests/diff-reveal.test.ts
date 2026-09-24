/**
 * A reveal from the review column seats the file a card-gap below the top of the canvas, not flush
 * against it. happy-dom lays nothing out, so the fixture stands in the geometry: the region's top
 * is pinned at zero while the card reports whatever offset the scroll has not taken up yet, the way
 * a real canvas converges when the delta reaches the gap.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REVIEW_WIDTH,
  MAX_REVIEW_WIDTH,
  MIN_REVIEW_WIDTH
} from '../src/shared/api'

const CWD = '/reveal-project'

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 const a = 1
-const b = 2
+const b = 3
diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
 const c = 1
-const d = 2
+const d = 3
`

const diff = {
  git: true,
  staged: [],
  unstaged: [
    { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 }
  ],
  all: [
    { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 }
  ]
}

test('a reveal seats the card a card-gap below the top', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  let domOurs = false
  try {
    GlobalRegistrator.register({ url: 'http://localhost' })
    domOurs = true
  } catch {
    // Another fixture in this process holds the document; the containers below keep every
    // assertion scoped, so sharing it is fine.
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // The reveal loop rides frames; one synchronous alignment is all this asserts, so frames park.
  Object.assign(globalThis, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/ipc/api', () => ({
    api: {
      readWorktreeDiff: async () => diff,
      readWorktreePatch: async () => ({ git: true, patch: PATCH, truncated: false }),
      readUntrackedFile: async () => ({ kind: 'text', contents: '', lines: 0 }),
      watchWorktreeDiff: async () => 'lease',
      unwatchWorktreeDiff: async () => {},
      onDiffChanged: () => () => {},
      onDiffWatchError: () => () => {}
    },
    DEFAULT_REVIEW_WIDTH,
    MAX_REVIEW_WIDTH,
    MIN_REVIEW_WIDTH
  }))
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { ChangesView } = await import('../src/renderer/src/components/diff/ChangesView')
  const { useDiffStore } = await import('../src/renderer/src/stores/diff')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(ChangesView, { cwd: CWD })) })
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }

  const region = container.querySelector('div.overflow-y-auto') as HTMLElement
  assert.ok(region, 'expected the scroll region to exist')
  const cards = [...container.querySelectorAll('section[id^="diff-section:"]')] as HTMLElement[]
  assert.equal(cards.length, 2)
  Object.defineProperty(region, 'getBoundingClientRect', {
    value: () => ({ top: 0 }) as unknown as DOMRect,
    configurable: true
  })
  for (const card of cards) {
    Object.defineProperty(card, 'getBoundingClientRect', {
      value: () => ({ top: 200 - region.scrollTop }) as unknown as DOMRect,
      configurable: true
    })
  }

  await act(async () => {
    useDiffStore.getState().focusPath(CWD, 'src/a.ts')
    await Promise.resolve()
  })
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
  // The card sits 200 down the canvas and keeps a 12 gap: flush against the top would read 200.
  assert.equal(region.scrollTop, 188)
  assert.deepEqual(
    cards.map((card) => card.querySelector('button')?.getAttribute('aria-expanded')),
    ['true', 'false']
  )
  await act(async () => { root.unmount() })
  if (domOurs) await GlobalRegistrator.unregister()
})
