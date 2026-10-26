import { create } from 'zustand'
import type { LayoutNode, PaneNode, SavedSplitLayout, SplitDirection, SplitNode } from '../../../shared/split-layout'

export type { LayoutNode, PaneNode, SplitDirection, SplitNode } from '../../../shared/split-layout'
export type SplitDropPosition = 'left' | 'right' | 'top' | 'bottom'

export interface ReintegratingTab {
  paneId: string
  tabId: string
}

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

/** One merged tab: a tree of two or more panes and the pane that last had focus in it. */
export interface SplitGroup {
  root: LayoutNode
  activePaneId: string
}

/** Every pane across all groups. A tab sits in at most one pane, so this is also the set of split tabs. */
export function allPanes(groups: readonly SplitGroup[]): PaneNode[] {
  return groups.flatMap((group) => collectPaneNodes(group.root))
}

export function groupOfPane(groups: readonly SplitGroup[], paneId: string | null | undefined): SplitGroup | null {
  if (!paneId) return null
  return groups.find((group) => findPaneNode(group.root, paneId)) ?? null
}

export function groupOfTab(groups: readonly SplitGroup[], tabId: string | null | undefined): SplitGroup | null {
  if (!tabId) return null
  return groups.find((group) => collectPaneNodes(group.root).some((pane) => pane.tabId === tabId)) ?? null
}

export function paneOfTab(groups: readonly SplitGroup[], tabId: string | null | undefined): PaneNode | null {
  if (!tabId) return null
  return allPanes(groups).find((pane) => pane.tabId === tabId) ?? null
}

/**
 * Removes a pane from whichever group holds it. A group left with fewer than two panes is no split any
 * more: it dissolves and its last tab goes back to the strip on its own.
 */
function withoutPane(groups: readonly SplitGroup[], paneId: string): SplitGroup[] {
  return groups.flatMap((group) => {
    const res = removePaneFromTree(group.root, paneId)
    if (!res.removed) return [group]
    const panes = collectPaneNodes(res.newTree)
    if (!res.newTree || panes.length < 2) return []
    const activePaneId = panes.some((pane) => pane.id === group.activePaneId) ? group.activePaneId : panes[0].id
    return [{ root: res.newTree, activePaneId }]
  })
}

function mapGroups(groups: SplitGroup[], update: (root: LayoutNode) => LayoutNode): SplitGroup[] {
  const next = groups.map((group) => {
    const root = update(group.root)
    return root === group.root ? group : { ...group, root }
  })
  return next.every((group, index) => group === groups[index]) ? groups : next
}

export interface SplitLayoutState {
  /** Independent splits, each shown as one merged tab; a tab belongs to at most one of them. */
  groups: SplitGroup[]
  dragOver: { paneId: string; position: SplitDropPosition } | null
  reintegratingTab: ReintegratingTab | null

  /** Splits a standalone tab into a new group with `tabId`, moving `tabId` out of any group it was in. */
  splitTab: (baseTabId: string, tabId: string, position: SplitDropPosition) => string
  /** Docks `tabId` beside a pane, moving it out of the pane it held before (in this or another group). */
  splitPane: (targetPaneId: string, tabId: string, position: SplitDropPosition) => string
  setSplitSizes: (splitId: string, sizes: number[]) => void
  /** Returns the tab its group now focuses, or the survivor of a group that dissolved; null otherwise. */
  closePane: (paneId: string) => string | null
  setPaneTab: (paneId: string, tabId: string) => void
  /** Points every pane that holds a tab at its new id, for a tab whose own identity moved. */
  renameTabId: (from: string, to: string) => void
  setActivePane: (paneId: string) => void
  setDragOver: (dragOver: { paneId: string; position: SplitDropPosition } | null) => void
  setReintegratingTab: (tab: ReintegratingTab | null) => void
  /**
   * Brings back the layouts saved at the last quit. A pane whose tab did not come back is removed the way
   * closing it would; a group with fewer than two panes left is no split at all.
   */
  restore: (layouts: readonly SavedSplitLayout[], openTabIds: ReadonlySet<string>, activeTabId: string | null) => void
  reset: () => void
}

export const useSplitLayoutStore = create<SplitLayoutState>((set, get) => ({
  groups: [],
  dragOver: null,
  reintegratingTab: null,

  splitTab: (baseTabId, tabId, position) => {
    if (baseTabId === tabId || paneOfTab(get().groups, baseTabId)) {
      throw Object.assign(new Error(`Split base is not a standalone tab: ${baseTabId}`), {
        code: 'ERR_SPLIT_TARGET'
      })
    }
    const source = paneOfTab(get().groups, tabId)
    const groups = source ? withoutPane(get().groups, source.id) : get().groups
    const base: PaneNode = { id: crypto.randomUUID(), tabId: baseTabId }
    const newPane: PaneNode = { id: crypto.randomUUID(), tabId }
    const root = splitNodeInTree(base, base.id, newPane, position).updated
    set({ groups: [...groups, { root, activePaneId: newPane.id }], dragOver: null })
    return newPane.id
  },

  splitPane: (targetPaneId, tabId, position) => {
    const state = get()
    const target = groupOfPane(state.groups, targetPaneId)
    const targetPane = target && findPaneNode(target.root, targetPaneId)
    if (!target || !targetPane || targetPane.tabId === tabId) {
      throw Object.assign(new Error(`Split target no longer exists: ${targetPaneId}`), {
        code: 'ERR_SPLIT_TARGET'
      })
    }
    // The source leaves first: inside the target's own group that may collapse it to the target alone,
    // which the split below fills again, so the group is only dissolved when it truly ends up short.
    const source = paneOfTab(state.groups, tabId)
    let groups = state.groups
    let targetRoot = target.root
    if (source) {
      const res = removePaneFromTree(target.root, source.id)
      if (res.removed) targetRoot = res.newTree!
      else groups = withoutPane(groups, source.id)
    }
    const newPane: PaneNode = { id: crypto.randomUUID(), tabId }
    const root = splitNodeInTree(targetRoot, targetPaneId, newPane, position).updated
    set({
      groups: groups.map((group) => (group === target ? { root, activePaneId: newPane.id } : group)),
      dragOver: null
    })
    return newPane.id
  },

  setSplitSizes: (splitId, sizes) =>
    set((state) => {
      const groups = mapGroups(state.groups, (root) => updateSplitSizes(root, splitId, sizes))
      return groups === state.groups ? state : { groups }
    }),

  closePane: (paneId: string) => {
    const state = get()
    const group = groupOfPane(state.groups, paneId)
    if (!group) return null
    const groups = withoutPane(state.groups, paneId)
    const others = collectPaneNodes(group.root).filter((pane) => pane.id !== paneId)
    const kept = groups.find((item) => others.some((pane) => findPaneNode(item.root, pane.id)))
    const survivor = kept ? findPaneNode(kept.root, kept.activePaneId) : others[0]
    set({
      groups,
      dragOver: state.dragOver?.paneId === paneId ? null : state.dragOver,
      reintegratingTab: state.reintegratingTab?.paneId === paneId ? null : state.reintegratingTab
    })
    return survivor?.tabId ?? null
  },

  setPaneTab: (paneId: string, tabId: string) =>
    set((state) => ({ groups: mapGroups(state.groups, (root) => updatePaneTabInTree(root, paneId, tabId)) })),

  renameTabId: (from: string, to: string) =>
    set((state) => {
      // The panes are what hold a tab id; the active *pane* is named by a pane id this never touches.
      const groups = mapGroups(state.groups, (root) => renameTabInTree(root, from, to))
      return groups === state.groups ? state : { groups }
    }),

  setActivePane: (paneId: string) =>
    set((state) => {
      const group = groupOfPane(state.groups, paneId)
      if (!group || group.activePaneId === paneId) return state
      return { groups: state.groups.map((item) => (item === group ? { ...item, activePaneId: paneId } : item)) }
    }),

  setDragOver: (dragOver) => {
    set({ dragOver })
  },

  setReintegratingTab: (reintegratingTab) => {
    set({ reintegratingTab })
  },

  restore: (layouts, openTabIds, activeTabId) => {
    const groups: SplitGroup[] = []
    const seen = new Set<string>()
    for (const layout of layouts) {
      let root: LayoutNode | null = layout.root
      for (const pane of collectPaneNodes(layout.root)) {
        if (root && (!openTabIds.has(pane.tabId) || seen.has(pane.tabId))) root = removePaneFromTree(root, pane.id).newTree
      }
      const panes = collectPaneNodes(root)
      if (!root || panes.length < 2) continue
      for (const pane of panes) seen.add(pane.tabId)
      const activePaneId = panes.find((pane) => pane.tabId === activeTabId)?.id ??
        panes.find((pane) => pane.id === layout.activePaneId)?.id ?? panes[0].id
      groups.push({ root, activePaneId })
    }
    if (groups.length) set({ groups, dragOver: null, reintegratingTab: null })
  },

  reset: () => {
    set({ groups: [], dragOver: null, reintegratingTab: null })
  }
}))
