import { beforeEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  allPanes,
  collectPaneNodes,
  groupOfTab,
  isSplitNode,
  paneOfTab,
  useSplitLayoutStore,
  type PaneNode,
  type SplitNode
} from '../src/renderer/src/stores/split-layout'

const store = () => useSplitLayoutStore.getState()
const paneId = (tabId: string) => paneOfTab(store().groups, tabId)!.id
const rootOf = (tabId: string) => groupOfTab(store().groups, tabId)!.root as SplitNode
const tabs = (tabId: string) => collectPaneNodes(groupOfTab(store().groups, tabId)!.root).map((pane) => pane.tabId)

describe('useSplitLayoutStore', () => {
  beforeEach(() => {
    store().reset()
  })

  test('starts with no groups', () => {
    assert.deepEqual(store().groups, [])
    assert.equal(store().dragOver, null)
  })

  test('splitTab places the new pane by position with [50, 50] sizes', () => {
    for (const [position, direction, order] of [
      ['right', 'horizontal', ['a', 'b']],
      ['left', 'horizontal', ['b', 'a']],
      ['top', 'vertical', ['b', 'a']],
      ['bottom', 'vertical', ['a', 'b']]
    ] as const) {
      store().reset()
      const b = store().splitTab('a', 'b', position)
      const root = rootOf('a')
      assert.equal(root.direction, direction)
      assert.deepEqual(root.sizes, [50, 50])
      assert.deepEqual(tabs('a'), order)
      assert.equal(groupOfTab(store().groups, 'a')!.activePaneId, b)
    }
  })

  test('a second split starts its own group and leaves the first one intact', () => {
    store().splitTab('a', 'b', 'right')
    const first = store().groups[0]
    store().splitTab('c', 'd', 'bottom')
    assert.equal(store().groups.length, 2)
    assert.equal(store().groups[0], first)
    assert.deepEqual(tabs('c'), ['c', 'd'])
    assert.throws(() => store().splitTab('a', 'e', 'right'), { code: 'ERR_SPLIT_TARGET' })
  })

  test('a tab moves out of its old group, which dissolves once it has one pane left', () => {
    store().splitTab('a', 'b', 'right')
    store().splitTab('c', 'd', 'right')
    store().splitPane(paneId('c'), 'a', 'left')
    assert.deepEqual(store().groups.map((group) => collectPaneNodes(group.root).map((pane) => pane.tabId)), [['a', 'c', 'd']])
    assert.equal(paneOfTab(store().groups, 'b'), null)
  })

  test('re-docking inside the same group keeps the group', () => {
    store().splitTab('a', 'b', 'right')
    store().splitPane(paneId('a'), 'b', 'bottom')
    assert.deepEqual(tabs('a'), ['a', 'b'])
    assert.equal(rootOf('a').direction, 'vertical')
  })

  test('splitPane nests in place and focuses the new pane', () => {
    store().splitTab('1', '2', 'right')
    const p3 = store().splitPane(paneId('2'), '3', 'bottom')
    const root = rootOf('1')
    assert.equal(root.direction, 'horizontal')
    assert.equal((root.children[0] as PaneNode).tabId, '1')
    const nested = root.children[1] as SplitNode
    assert.equal(isSplitNode(nested), true)
    assert.equal(nested.direction, 'vertical')
    assert.deepEqual(nested.children.map((child) => (child as PaneNode).tabId), ['2', '3'])
    assert.equal(groupOfTab(store().groups, '1')!.activePaneId, p3)
  })

  test('closePane collapses nested splits and dissolves a group left with one pane', () => {
    store().splitTab('1', '2', 'right')
    store().splitPane(paneId('2'), '3', 'bottom')
    assert.equal(store().closePane(paneId('2')), '3')
    assert.deepEqual(tabs('1'), ['1', '3'])
    assert.equal(rootOf('1').direction, 'horizontal')
    assert.equal(store().closePane(paneId('1')), '3', 'the survivor of a dissolved group')
    assert.deepEqual(store().groups, [])
    assert.equal(store().closePane('missing'), null)
  })

  test('closePane promotes a nested split when the root loses its other child', () => {
    store().splitTab('1', '2', 'right')
    store().splitPane(paneId('2'), '3', 'bottom')
    store().closePane(paneId('1'))
    assert.equal(rootOf('2').direction, 'vertical')
    assert.deepEqual(tabs('2'), ['2', '3'])
  })

  test('closing a pane in one group leaves the other group alone', () => {
    store().splitTab('a', 'b', 'right')
    store().splitTab('c', 'd', 'right')
    const second = store().groups[1]
    store().closePane(paneId('a'))
    assert.deepEqual(store().groups, [second])
  })

  test('setPaneTab and setActivePane act on the group holding the pane', () => {
    store().splitTab('old', '2', 'right')
    store().splitTab('x', 'y', 'right')
    store().setPaneTab(paneId('old'), 'new')
    assert.deepEqual(tabs('new'), ['new', '2'])
    store().setActivePane(paneId('new'))
    assert.equal(groupOfTab(store().groups, 'new')!.activePaneId, paneId('new'))
    assert.equal(groupOfTab(store().groups, 'x')!.activePaneId, paneId('y'), 'the other group keeps its focus')
  })

  test('dragOver clears when its pane closes', () => {
    store().splitTab('1', '2', 'right')
    const p1 = paneId('1')
    store().setDragOver({ paneId: p1, position: 'bottom' })
    store().closePane(p1)
    assert.equal(store().dragOver, null)
  })

  test('resizing preserves nested proportions without replacing pane identities', () => {
    store().splitTab('A', 'B', 'right')
    const c = store().splitPane(paneId('B'), 'C', 'bottom')
    const root = rootOf('A')
    const nested = root.children[1] as SplitNode
    store().setSplitSizes(root.id, [70, 30])
    store().setSplitSizes(nested.id, [40, 60])
    const resized = rootOf('A')
    assert.deepEqual(resized.sizes, [70, 30])
    assert.deepEqual((resized.children[1] as SplitNode).sizes, [40, 60])
    assert.equal(((resized.children[1] as SplitNode).children[1] as PaneNode).id, c)
    assert.throws(() => store().setSplitSizes(root.id, [NaN, 30]), { code: 'ERR_SPLIT_SIZES' })
    assert.throws(() => store().setSplitSizes(root.id, [100]), { code: 'ERR_SPLIT_SIZES' })
    assert.equal(rootOf('A'), resized)
  })

  test('invalid split targets fail loudly without docking into an unrelated pane', () => {
    assert.throws(() => store().splitPane('missing', 'B', 'right'), { code: 'ERR_SPLIT_TARGET' })
    store().splitTab('A', 'B', 'right')
    const groups = store().groups
    assert.throws(() => store().splitPane('missing', 'C', 'right'), { code: 'ERR_SPLIT_TARGET' })
    assert.throws(() => store().splitTab('A', 'A', 'right'), { code: 'ERR_SPLIT_TARGET' })
    assert.equal(store().groups, groups)
  })
})

describe('renameTabId', () => {
  beforeEach(() => {
    store().reset()
  })

  test('follows the tab through a split and leaves the other panes alone', () => {
    store().splitTab('file:/p\0a.ts', 'file:/p\0other.ts', 'right')
    store().renameTabId('file:/p\0a.ts', 'file:/p\0b.ts')
    assert.deepEqual(allPanes(store().groups).map((pane) => pane.tabId), ['file:/p\0b.ts', 'file:/p\0other.ts'])
  })

  test('answering nothing leaves the layout identical', () => {
    store().splitTab('file:/p\0a.ts', 'file:/p\0b.ts', 'right')
    const before = store().groups
    store().renameTabId('file:/p\0nowhere.ts', 'file:/p\0c.ts')
    assert.equal(store().groups, before)
  })

  test('restore drops panes whose tabs did not come back and keeps the active tab in view', () => {
    const saved = {
      root: {
        id: 'outer', direction: 'horizontal' as const, sizes: [30, 70],
        children: [
          { id: 'p1', tabId: 'a' },
          { id: 'inner', direction: 'vertical' as const, sizes: [40, 60], children: [{ id: 'p2', tabId: 'gone' }, { id: 'p3', tabId: 'c' }] }
        ]
      },
      activePaneId: 'p2'
    }
    const other = { root: { id: 's', direction: 'vertical' as const, sizes: [50, 50], children: [{ id: 'q1', tabId: 'x' }, { id: 'q2', tabId: 'y' }] }, activePaneId: 'q1' }
    store().restore([saved, other], new Set(['a', 'c', 'x', 'y']), 'c')
    assert.deepEqual(store().groups, [
      { root: { id: 'outer', direction: 'horizontal', sizes: [30, 70], children: [{ id: 'p1', tabId: 'a' }, { id: 'p3', tabId: 'c' }] }, activePaneId: 'p3' },
      { root: other.root, activePaneId: 'q1' }
    ])

    store().reset()
    store().restore([saved], new Set(['a']), 'a')
    assert.deepEqual(store().groups, [], 'one surviving pane is no split')
  })
})
