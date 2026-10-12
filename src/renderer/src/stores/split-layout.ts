import { create } from 'zustand'

export type SplitDirection = 'horizontal' | 'vertical'
export type SplitDropPosition = 'left' | 'right' | 'top' | 'bottom'

export interface PaneNode {
  id: string
  tabId: string
}

export interface ReintegratingTab {
  paneId: string
  tabId: string
}

export interface SplitNode {
  id: string
  direction: SplitDirection
  children: (PaneNode | SplitNode)[]
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export function isPaneNode(node: LayoutNode): node is PaneNode {
  return 'tabId' in node && !('children' in node)
}

export function isSplitNode(node: LayoutNode): node is SplitNode {
  return 'children' in node && Array.isArray((node as SplitNode).children)
}

export function collectPaneNodes(node: LayoutNode | null): PaneNode[] {
  if (!node) return []
  if (isPaneNode(node)) return [node]
  return node.children.flatMap((child) => collectPaneNodes(child))
}

export function findPaneNode(node: LayoutNode | null, paneId: string): PaneNode | null {
  if (!node) return null
  if (isPaneNode(node)) return node.id === paneId ? node : null
  for (const child of node.children) {
    const found = findPaneNode(child, paneId)
    if (found) return found
  }
  return null
}

function splitNodeInTree(
  node: LayoutNode,
  targetPaneId: string,
  newPane: PaneNode,
  position: SplitDropPosition
): { updated: LayoutNode; found: boolean } {
  if (isPaneNode(node)) {
    if (node.id === targetPaneId) {
      const direction: SplitDirection =
        position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
      const children = position === 'left' || position === 'top' ? [newPane, node] : [node, newPane]
      const split: SplitNode = {
        id: crypto.randomUUID(),
        direction,
        children,
        sizes: [50, 50]
      }
      return { updated: split, found: true }
    }
    return { updated: node, found: false }
  }

  let found = false
  const nextChildren: (PaneNode | SplitNode)[] = []
  for (const child of node.children) {
    if (!found) {
      const res = splitNodeInTree(child, targetPaneId, newPane, position)
      if (res.found) {
        found = true
        nextChildren.push(res.updated)
        continue
      }
    }
    nextChildren.push(child)
  }

  return {
    updated: found ? { ...node, children: nextChildren } : node,
    found
  }
}

function removePaneFromTree(
  node: LayoutNode,
  paneId: string
): { newTree: LayoutNode | null; removed: boolean } {
  if (isPaneNode(node)) {
    if (node.id === paneId) {
      return { newTree: null, removed: true }
    }
    return { newTree: node, removed: false }
  }

  let removed = false
  const newChildren: (PaneNode | SplitNode)[] = []
  const newSizes: number[] = []

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (isPaneNode(child)) {
      if (child.id === paneId) {
        removed = true
        continue
      }
      newChildren.push(child)
      newSizes.push(node.sizes[i] ?? 100 / node.children.length)
    } else {
      if (!removed) {
        const res = removePaneFromTree(child, paneId)
        if (res.removed) {
          removed = true
          if (res.newTree !== null) {
            newChildren.push(res.newTree)
            newSizes.push(node.sizes[i] ?? 100 / node.children.length)
          }
          continue
        }
      }
      newChildren.push(child)
      newSizes.push(node.sizes[i] ?? 100 / node.children.length)
    }
  }

  if (!removed) {
    return { newTree: node, removed: false }
  }

  if (newChildren.length === 0) {
    return { newTree: null, removed: true }
  }

  if (newChildren.length === 1) {
    // 父节点只剩一个子节点则自动折叠提升
    return { newTree: newChildren[0], removed: true }
  }

  const sum = newSizes.reduce((acc, val) => acc + val, 0)
  const normalizedSizes =
    sum > 0
      ? newSizes.map((val) => (val / sum) * 100)
      : newChildren.map(() => 100 / newChildren.length)

  return {
    newTree: {
      ...node,
      children: newChildren,
      sizes: normalizedSizes
    },
    removed: true
  }
}

function updatePaneTabInTree(node: LayoutNode, paneId: string, tabId: string): LayoutNode {
  if (isPaneNode(node)) {
    if (node.id === paneId) {
      return { ...node, tabId }
    }
    return node
  }
  return {
    ...node,
    children: node.children.map((child) => updatePaneTabInTree(child, paneId, tabId))
  }
}

/**
 * The same walk for a tab whose own id moved, which is what renaming a file does to its tab: the
 * identity is the path, so the row moving means every pane holding it has to follow.
 */
function renameTabInTree(node: LayoutNode, from: string, to: string): LayoutNode {
  if (isPaneNode(node)) return node.tabId === from ? { ...node, tabId: to } : node
  const children = node.children.map((child) => renameTabInTree(child, from, to))
  return children.every((child, index) => child === node.children[index])
    ? node
    : { ...node, children }
}

function updateSplitSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (isPaneNode(node)) return node
  if (node.id === splitId) {
    if (
      sizes.length !== node.children.length ||
      sizes.some((size) => !Number.isFinite(size) || size < 0) ||
      sizes.reduce((sum, size) => sum + size, 0) <= 0
    ) {
      throw Object.assign(new Error(`Invalid panel sizes for ${splitId}`), {
        code: 'ERR_SPLIT_SIZES'
      })
    }
    if (sizes.every((size, index) => size === node.sizes[index])) return node
    return { ...node, sizes: [...sizes] }
  }
  const children = node.children.map((child) => updateSplitSizes(child, splitId, sizes))
  return children.every((child, index) => child === node.children[index])
    ? node
    : { ...node, children }
}

export interface SplitLayoutState {
  root: LayoutNode | null
  activePaneId: string | null
  dragOver: { paneId: string; position: SplitDropPosition } | null
  reintegratingTab: ReintegratingTab | null

  initLayout: (tabId: string) => string
  splitPane: (targetPaneId: string, tabId: string, position: SplitDropPosition) => string
  setSplitSizes: (splitId: string, sizes: number[]) => void
  closePane: (paneId: string) => void
  setPaneTab: (paneId: string, tabId: string) => void
  /** Points every pane that holds a tab at its new id, for a tab whose own identity moved. */
  renameTabId: (from: string, to: string) => void
  setActivePane: (paneId: string) => void
  setDragOver: (dragOver: { paneId: string; position: SplitDropPosition } | null) => void
  setReintegratingTab: (tab: ReintegratingTab | null) => void
  reset: () => void
}

export const useSplitLayoutStore = create<SplitLayoutState>((set, get) => ({
  root: null,
  activePaneId: null,
  dragOver: null,
  reintegratingTab: null,

  initLayout: (tabId: string) => {
    const paneId = crypto.randomUUID()
    const rootPane: PaneNode = {
      id: paneId,
      tabId
    }
    set({
      root: rootPane,
      activePaneId: paneId,
      dragOver: null
    })
    return paneId
  },

  splitPane: (targetPaneId: string, tabId: string, position: SplitDropPosition) => {
    const currentRoot = get().root
    if (!currentRoot || !findPaneNode(currentRoot, targetPaneId)) {
      throw Object.assign(new Error(`Split target no longer exists: ${targetPaneId}`), {
        code: 'ERR_SPLIT_TARGET'
      })
    }

    const newPaneId = crypto.randomUUID()
    const newPane: PaneNode = {
      id: newPaneId,
      tabId
    }

    const res = splitNodeInTree(currentRoot, targetPaneId, newPane, position)

    set({
      root: res.updated,
      activePaneId: newPaneId,
      dragOver: null
    })
    return newPaneId
  },

  setSplitSizes: (splitId, sizes) =>
    set((state) => {
      if (!state.root) return state
      const root = updateSplitSizes(state.root, splitId, sizes)
      return root === state.root ? state : { root }
    }),

  closePane: (paneId: string) => {
    const state = get()
    if (!state.root) return

    const res = removePaneFromTree(state.root, paneId)
    if (!res.removed) return

    const newRoot = res.newTree
    const remainingPanes = collectPaneNodes(newRoot)
    const nextActiveId =
      state.activePaneId === paneId || !remainingPanes.some((p) => p.id === state.activePaneId)
        ? (remainingPanes[0]?.id ?? null)
        : state.activePaneId

    const nextDragOver = state.dragOver?.paneId === paneId ? null : state.dragOver
    const nextReintegratingTab =
      state.reintegratingTab?.paneId === paneId ? null : state.reintegratingTab

    set({
      root: newRoot,
      activePaneId: nextActiveId,
      dragOver: nextDragOver,
      reintegratingTab: nextReintegratingTab
    })
  },

  setPaneTab: (paneId: string, tabId: string) => {
    const { root } = get()
    if (!root) return
    set({ root: updatePaneTabInTree(root, paneId, tabId) })
  },

  renameTabId: (from: string, to: string) =>
    set((state) => {
      if (!state.root) return state
      const root = renameTabInTree(state.root, from, to)
      // The panes are what hold a tab id, and `renameTabInTree` is what walks them; there is nothing else
      // to update, and the active *pane* is named by a pane id this never touches.
      return root === state.root ? state : { root }
    }),

  setActivePane: (paneId: string) => {
    set({ activePaneId: paneId })
  },

  setDragOver: (dragOver) => {
    set({ dragOver })
  },

  setReintegratingTab: (reintegratingTab) => {
    set({ reintegratingTab })
  },

  reset: () => {
    set({
      root: null,
      activePaneId: null,
      dragOver: null,
      reintegratingTab: null
    })
  }
}))
