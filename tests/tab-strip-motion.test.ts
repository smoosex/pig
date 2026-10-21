/** Tabs grow in and collapse out so the centred strip never jumps by a whole tab's width. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'
import { interleave } from '../src/renderer/src/components/use-tab-strip-motion'

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
    const child = Bun.spawn([process.execPath, import.meta.path, '--tab-motion-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}
