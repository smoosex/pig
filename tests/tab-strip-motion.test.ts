/** Tabs grow in and collapse out so the centred strip never jumps by a whole tab's width. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'
import { interleave } from '../src/renderer/src/components/use-tab-strip-motion'
import { runSelf } from './helpers/subprocess.ts'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const animations: { element: HTMLElement; keyframes: Keyframe[]; animation: { onfinish: (() => void) | null } }[] = []
  HTMLElement.prototype.animate = function (keyframes) {
    const animation = { onfinish: null as (() => void) | null }
    animations.push({ element: this, keyframes: keyframes as Keyframe[], animation })
    return animation as unknown as Animation
  }
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { fileTabId } = await import('../src/renderer/src/stores/sessions/tabs-slice')
  const { TabBar } = await import('../src/renderer/src/components/TabBar')
  const tab = (id: string, cwd = '/p'): OpenTab => ({ id, cwd, kind: 'project', title: id, loadState: 'ready' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (openTabs: OpenTab[], activeTabId: string, currentProjectCwd = '/p') =>
    act(async () => {
      store.setState({ openTabs, activeTabId, currentProjectCwd })
      root.render(h(TabBar, { sidebarTab: 'projects' }))
    })
  const listed = () => [...container.querySelectorAll('[data-session-tab]')].map((item) => item.textContent)
  try {
    await render([tab('A'), tab('B')], 'B')
    assert.equal(animations.length, 0, 'the first strip appears without motion')

    await render([tab('A')], 'A')
    const ghost = container.querySelector<HTMLElement>('[aria-hidden="true"].group\\/tab')
    assert.equal(ghost?.textContent, 'B', 'the closed tab collapses in place')
    assert.deepEqual(listed(), ['A'], 'the collapsing copy is not a tab')
    const collapse = animations.find((item) => item.element === ghost)!
    assert.equal(collapse.keyframes.at(-1)!.flexBasis, '0px')
    await act(async () => { collapse.animation.onfinish!() })
    assert.equal(container.querySelector('[aria-hidden="true"].group\\/tab'), null)

    animations.length = 0
    await render([tab('A'), tab('C')], 'C')
    assert.deepEqual(animations.map((item) => item.element.dataset.tabKey), ['C'], 'only the new tab grows in')
    assert.deepEqual([animations[0].keyframes[0].offset, animations[0].keyframes[0].flexBasis], [0, '0px'], 'the new tab starts from nothing, not ends there')
    const firstFace = container.querySelector<HTMLElement>('[data-tab-key="A"]')!
    assert.ok(firstFace.classList.contains('grow-1000'), 'deactivating a lone tab keeps sum(flex-grow) >= 1 so the strip does not dip and rebound')

    animations.length = 0
    const fileId = fileTabId('/p', 'src/chapter.md')
    await act(async () => {
      await store.getState().openFileTab('/p', 'src/chapter.md')
    })
    assert.deepEqual(
      animations.map((item) => item.element.dataset.tabKey),
      [fileId],
      'file tabs whose data-tab-key contains U+0000 still run their entry width animation'
    )
    assert.deepEqual([animations[0].keyframes[0].offset, animations[0].keyframes[0].flexBasis], [0, '0px'])
    const previewFace = container.querySelector<HTMLElement>('[data-tab-preview]')!
    assert.ok(previewFace, 'preview file tab carries preview marker')
    assert.ok(previewFace.querySelector('[data-tab-label]')?.classList.contains('italic'), 'preview tab label is italic')

    // Previewing another file reuses the same tab slot without collapsing or re-growing in the strip.
    animations.length = 0
    await act(async () => {
      await store.getState().openFileTab('/p', 'src/next.md')
    })
    assert.equal(animations.length, 0, 'in-place preview replacement does not animate as close + open')
    assert.equal(container.querySelector('[aria-hidden="true"].group\\/tab'), null, 'no leaving ghost tab is spawned')
    assert.deepEqual(listed(), ['A', 'C', 'next.md'])

    // Double-clicking the preview tab in the strip pins it in place.
    const nextFace = container.querySelector<HTMLElement>('[data-tab-preview]')!
    await act(async () => {
      nextFace.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
    })
    assert.equal(container.querySelector('[data-tab-preview]'), null, 'double-clicking a preview tab pins it')
    assert.equal(nextFace.querySelector('[data-tab-label]')?.classList.contains('italic'), false)

    animations.length = 0
    await render([tab('D', '/q')], 'D', '/q')
    assert.equal(animations.length, 0, 'switching worktree replaces the strip without motion')
    assert.deepEqual(listed(), ['D'])
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--tab-motion-fixture') {
  await runFixture()
} else {
  test('leaving copies stay where their tab was, chained copies included', () => {
    const ghost = (key: string, after: string | null) => ({ key, after })
    const layout = interleave(['a', 'd'], (item) => item, [ghost('b', 'a'), ghost('c', 'b'), ghost('z', null), ghost('x', 'gone')])
    assert.deepEqual(
      layout.map((slot) => ('item' in slot ? slot.item : `~${slot.leaving.key}`)),
      ['~z', 'a', '~b', '~c', 'd', '~x']
    )
  })

  test('closing and adding tabs animate within one strip only', async () => {
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--tab-motion-fixture'])
    assert.equal(code, 0, stdout + stderr)
  })
}
