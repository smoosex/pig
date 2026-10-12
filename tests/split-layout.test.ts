import { beforeEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  isPaneNode,
  isSplitNode,
  useSplitLayoutStore,
  type PaneNode,
  type SplitNode
} from '../src/renderer/src/stores/split-layout'

describe('useSplitLayoutStore', () => {
  beforeEach(() => {
    useSplitLayoutStore.getState().reset()
  })

  test('initial state has null root and activePaneId', () => {
    const state = useSplitLayoutStore.getState()
    assert.equal(state.root, null)
    assert.equal(state.activePaneId, null)
    assert.equal(state.dragOver, null)
  })

  test('initLayout initializes a single pane as root', () => {
    const paneId = useSplitLayoutStore.getState().initLayout('tab-a')
    const state = useSplitLayoutStore.getState()

    assert.ok(state.root !== null)
    assert.equal(isPaneNode(state.root), true)
    const rootPane = state.root as PaneNode
    assert.equal(rootPane.id, paneId)
    assert.equal(rootPane.tabId, 'tab-a')
    assert.equal(state.activePaneId, paneId)
    assert.equal(state.dragOver, null)
  })

  test('splitPane splits target pane horizontally or vertically with [50, 50] sizes', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-a')

    // Split right: horizontal, [p1, p2]
    const p2 = useSplitLayoutStore.getState().splitPane(p1, 'tab-b', 'right')!
    assert.ok(p2)
    const state1 = useSplitLayoutStore.getState()
    assert.equal(isSplitNode(state1.root!), true)
    const split1 = state1.root as SplitNode
    assert.equal(split1.direction, 'horizontal')
    assert.deepEqual(split1.sizes, [50, 50])
    assert.equal(split1.children.length, 2)
    assert.equal((split1.children[0] as PaneNode).id, p1)
    assert.equal((split1.children[1] as PaneNode).id, p2)
    assert.equal(state1.activePaneId, p2)

    // Reset and test split left: horizontal, [p3, p1]
    useSplitLayoutStore.getState().reset()
    const pRoot = useSplitLayoutStore.getState().initLayout('tab-a')
    const pLeft = useSplitLayoutStore.getState().splitPane(pRoot, 'tab-left', 'left')!
    const stateLeft = useSplitLayoutStore.getState()
    const splitLeft = stateLeft.root as SplitNode
    assert.equal(splitLeft.direction, 'horizontal')
    assert.equal((splitLeft.children[0] as PaneNode).id, pLeft)
    assert.equal((splitLeft.children[1] as PaneNode).id, pRoot)

    // Reset and test split top: vertical, [pTop, pRoot]
    useSplitLayoutStore.getState().reset()
    const pRoot2 = useSplitLayoutStore.getState().initLayout('tab-a')
    const pTop = useSplitLayoutStore.getState().splitPane(pRoot2, 'tab-top', 'top')!
    const stateTop = useSplitLayoutStore.getState()
    const splitTop = stateTop.root as SplitNode
    assert.equal(splitTop.direction, 'vertical')
    assert.equal((splitTop.children[0] as PaneNode).id, pTop)
    assert.equal((splitTop.children[1] as PaneNode).id, pRoot2)

    // Reset and test split bottom: vertical, [pRoot, pBottom]
    useSplitLayoutStore.getState().reset()
    const pRoot3 = useSplitLayoutStore.getState().initLayout('tab-a')
    const pBottom = useSplitLayoutStore.getState().splitPane(pRoot3, 'tab-bottom', 'bottom')!
    const stateBottom = useSplitLayoutStore.getState()
    const splitBottom = stateBottom.root as SplitNode
    assert.equal(splitBottom.direction, 'vertical')
    assert.equal((splitBottom.children[0] as PaneNode).id, pRoot3)
    assert.equal((splitBottom.children[1] as PaneNode).id, pBottom)
  })

  test('splitPane nested split replaces target pane in-place with a SplitNode', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    const p2 = useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')!

    // Split p2 downwards
    const p3 = useSplitLayoutStore.getState().splitPane(p2, 'tab-3', 'bottom')!
    const root = useSplitLayoutStore.getState().root as SplitNode

    assert.equal(root.direction, 'horizontal')
    assert.deepEqual(root.sizes, [50, 50])
    assert.equal((root.children[0] as PaneNode).id, p1)

    const nested = root.children[1] as SplitNode
    assert.equal(isSplitNode(nested), true)
    assert.equal(nested.direction, 'vertical')
    assert.deepEqual(nested.sizes, [50, 50])
    assert.equal((nested.children[0] as PaneNode).id, p2)
    assert.equal((nested.children[1] as PaneNode).id, p3)
    assert.equal(useSplitLayoutStore.getState().activePaneId, p3)
  })

  test('closePane automatically collapses parent when only one child remains', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    const p2 = useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')!

    // Close p1: the parent SplitNode only has p2 remaining, so it collapses to p2
    useSplitLayoutStore.getState().closePane(p1)
    const state = useSplitLayoutStore.getState()
    assert.equal(isPaneNode(state.root!), true)
    assert.equal((state.root as PaneNode).id, p2)
    assert.equal(state.activePaneId, p2)

    // Close the last remaining pane: root becomes null
    useSplitLayoutStore.getState().closePane(p2)
    const emptyState = useSplitLayoutStore.getState()
    assert.equal(emptyState.root, null)
    assert.equal(emptyState.activePaneId, null)
  })

  test('closePane multi-level collapse promotes child and unfolds root appropriately', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    const p2 = useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')!
    const p3 = useSplitLayoutStore.getState().splitPane(p2, 'tab-3', 'bottom')!

    // Layout: S1(horizontal: [p1, S2(vertical: [p2, p3])])
    // Close p2: S2 collapses to p3. S1 becomes [p1, p3]
    useSplitLayoutStore.getState().closePane(p2)
    const state1 = useSplitLayoutStore.getState()
    const root1 = state1.root as SplitNode
    assert.equal(isSplitNode(root1), true)
    assert.equal(root1.children.length, 2)
    assert.equal((root1.children[0] as PaneNode).id, p1)
    assert.equal((root1.children[1] as PaneNode).id, p3)

    // Next, close p1: S1 collapses to p3, making p3 the new root PaneNode
    useSplitLayoutStore.getState().closePane(p1)
    const state2 = useSplitLayoutStore.getState()
    assert.equal(isPaneNode(state2.root!), true)
    assert.equal((state2.root as PaneNode).id, p3)
  })

  test('closePane collapses parent when first child of root is closed', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    const p2 = useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')!
    const p3 = useSplitLayoutStore.getState().splitPane(p2, 'tab-3', 'bottom')!

    // Layout: S1(horizontal: [p1, S2(vertical: [p2, p3])])
    // Close p1: S1 only has S2 remaining, so S1 collapses and S2 becomes root
    useSplitLayoutStore.getState().closePane(p1)
    const state = useSplitLayoutStore.getState()
    assert.equal(isSplitNode(state.root!), true)
    const root = state.root as SplitNode
    assert.equal(root.direction, 'vertical')
    assert.equal((root.children[0] as PaneNode).id, p2)
    assert.equal((root.children[1] as PaneNode).id, p3)
  })

  test('setPaneTab updates tabId of specified pane', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-old')
    useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')

    useSplitLayoutStore.getState().setPaneTab(p1, 'tab-new')
    const root = useSplitLayoutStore.getState().root as SplitNode
    assert.equal((root.children[0] as PaneNode).tabId, 'tab-new')
    assert.equal((root.children[1] as PaneNode).tabId, 'tab-2')
  })

  test('setActivePane changes activePaneId', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    const p2 = useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')!

    useSplitLayoutStore.getState().setActivePane(p1)
    assert.equal(useSplitLayoutStore.getState().activePaneId, p1)

    useSplitLayoutStore.getState().setActivePane(p2)
    assert.equal(useSplitLayoutStore.getState().activePaneId, p2)
  })

  test('setDragOver updates dragOver state and resets when pane closes', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    useSplitLayoutStore.getState().setDragOver({ paneId: p1, position: 'right' })
    assert.deepEqual(useSplitLayoutStore.getState().dragOver, { paneId: p1, position: 'right' })

    useSplitLayoutStore.getState().setDragOver(null)
    assert.equal(useSplitLayoutStore.getState().dragOver, null)

    useSplitLayoutStore.getState().setDragOver({ paneId: p1, position: 'bottom' })
    useSplitLayoutStore.getState().closePane(p1)
    assert.equal(useSplitLayoutStore.getState().dragOver, null)
  })

  test('resizing preserves nested proportions without replacing pane identities', () => {
    const a = useSplitLayoutStore.getState().initLayout('A')
    const b = useSplitLayoutStore.getState().splitPane(a, 'B', 'right')
    const c = useSplitLayoutStore.getState().splitPane(b, 'C', 'bottom')
    const root = useSplitLayoutStore.getState().root as SplitNode
    const nested = root.children[1] as SplitNode
    useSplitLayoutStore.getState().setSplitSizes(root.id, [70, 30])
    useSplitLayoutStore.getState().setSplitSizes(nested.id, [40, 60])
    const resized = useSplitLayoutStore.getState().root as SplitNode
    assert.deepEqual(resized.sizes, [70, 30])
    assert.deepEqual((resized.children[1] as SplitNode).sizes, [40, 60])
    assert.equal((resized.children[0] as PaneNode).id, a)
    assert.equal(((resized.children[1] as SplitNode).children[1] as PaneNode).id, c)
    assert.throws(() => useSplitLayoutStore.getState().setSplitSizes(root.id, [NaN, 30]), {
      code: 'ERR_SPLIT_SIZES'
    })
    assert.throws(() => useSplitLayoutStore.getState().setSplitSizes(root.id, [100]), {
      code: 'ERR_SPLIT_SIZES'
    })
    assert.equal(useSplitLayoutStore.getState().root, resized)
  })

  test('invalid split targets fail loudly without docking into an unrelated pane', () => {
    assert.throws(() => useSplitLayoutStore.getState().splitPane('missing', 'B', 'right'), {
      code: 'ERR_SPLIT_TARGET'
    })
    useSplitLayoutStore.getState().initLayout('A')
    const root = useSplitLayoutStore.getState().root
    assert.throws(() => useSplitLayoutStore.getState().splitPane('missing', 'B', 'right'), {
      code: 'ERR_SPLIT_TARGET'
    })
    assert.equal(useSplitLayoutStore.getState().root, root)
  })

  test('reset restores initial empty state', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('tab-1')
    useSplitLayoutStore.getState().splitPane(p1, 'tab-2', 'right')
    useSplitLayoutStore.getState().setDragOver({ paneId: p1, position: 'top' })

    useSplitLayoutStore.getState().reset()
    const state = useSplitLayoutStore.getState()
    assert.equal(state.root, null)
    assert.equal(state.activePaneId, null)
    assert.equal(state.dragOver, null)
  })
})

describe('renameTabId', () => {
  beforeEach(() => {
    useSplitLayoutStore.getState().reset()
  })

  test('points the pane holding a tab at its new id', () => {
    const paneId = useSplitLayoutStore.getState().initLayout('file:/p\0a.ts')
    useSplitLayoutStore.getState().renameTabId('file:/p\0a.ts', 'file:/p\0b.ts')
    const root = useSplitLayoutStore.getState().root as PaneNode
    assert.equal(root.id, paneId)
    assert.equal(root.tabId, 'file:/p\0b.ts')
  })

  test('follows the tab through a split and leaves the other panes alone', () => {
    const p1 = useSplitLayoutStore.getState().initLayout('file:/p\0a.ts')
    useSplitLayoutStore.getState().splitPane(p1, 'file:/p\0other.ts', 'right')
    useSplitLayoutStore.getState().renameTabId('file:/p\0a.ts', 'file:/p\0b.ts')
    const root = useSplitLayoutStore.getState().root as SplitNode
    const ids = JSON.stringify(root)
    assert.match(ids, /file:\/p\\u0000b\.ts/)
    assert.match(ids, /file:\/p\\u0000other\.ts/)
    assert.doesNotMatch(ids, /file:\/p\\u0000a\.ts/)
  })

  test('answering nothing leaves the layout identical', () => {
    useSplitLayoutStore.getState().initLayout('file:/p\0a.ts')
    const before = useSplitLayoutStore.getState().root
    useSplitLayoutStore.getState().renameTabId('file:/p\0nowhere.ts', 'file:/p\0b.ts')
    assert.equal(useSplitLayoutStore.getState().root, before)
  })
})
