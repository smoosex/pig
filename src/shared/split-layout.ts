/** The split-pane tree shared by the renderer's layout store and the restart record main keeps of it. */
export type SplitDirection = 'horizontal' | 'vertical'

export interface PaneNode {
  id: string
  tabId: string
}

export interface SplitNode {
  id: string
  direction: SplitDirection
  children: (PaneNode | SplitNode)[]
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export interface SavedSplitLayout {
  root: LayoutNode
  activePaneId: string | null
}
