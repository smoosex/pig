/**
 * Project the SDK session tree into visible rows.
 * Hidden bookkeeping entries remain in the SDK tree; only their visual ancestry is collapsed.
 */
import { homedir } from 'node:os'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { SessionTreeGutter, SessionTreeRow } from '../../shared/api'
import type { SessionSource } from './session-source'

type TreeNode = {
  entry: {
    id: string
    type: string
    summary?: string
    tokensBefore?: number
    customType?: string
    modelId?: string
    thinkingLevel?: string
    name?: string
    message?: {
      role?: string
      content?: unknown
      command?: string
      toolCallId?: string
      toolName?: string
      stopReason?: string
      errorMessage?: string
    }
  }
  children: TreeNode[]
}

function isHiddenEntry(type: string): boolean {
  return (
    type === 'label' ||
    type === 'custom' ||
    type === 'model_change' ||
    type === 'thinking_level_change' ||
    type === 'session_info'
  )
}

function oneLine(value: string, max = 120): string {
  return value.replace(/[\n\t]/g, ' ').trim().slice(0, max)
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return oneLine(content)
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    if (text.length >= 120) break
  }
  return oneLine(text)
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      return true
    }
  }
  return false
}

function hideInDefaultView(entry: TreeNode['entry'], current: boolean): boolean {
  if (isHiddenEntry(entry.type)) return true
  if (entry.type !== 'message' || entry.message?.role !== 'assistant' || current) return false
  const stop = entry.message.stopReason
  const isErrorOrAborted = Boolean(stop && stop !== 'stop' && stop !== 'toolUse')
  return !hasTextContent(entry.message.content) && !isErrorOrAborted && !entry.message.errorMessage
}

function shortenPath(path: string): string {
  const home = homedir()
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function scalarPreview(args: Record<string, unknown>, max = 40): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    parts.push(`${key}:${String(value)}`)
    if (parts.join(', ').length >= max) break
  }
  return oneLine(parts.join(', '), max)
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read':
      return `[read: ${shortenPath(String(args.path || args.file_path || ''))}]`
    case 'write':
      return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`
    case 'edit':
      return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`
    case 'bash': {
      const raw = String(args.command || '')
      const cmd = oneLine(raw, 50)
      return `[bash: ${cmd}${raw.length > 50 ? '...' : ''}]`
    }
    case 'ls':
      return `[ls: ${shortenPath(String(args.path || '.'))}]`
    case 'grep':
    case 'ffgrep':
      return `[${name}: ${oneLine(String(args.pattern || scalarPreview(args)), 40)}]`
    case 'find':
    case 'fffind':
      return `[${name}: ${oneLine(String(args.pattern || ''), 40)}]`
    default:
      return `[${name}: ${scalarPreview(args)}]`
  }
}

function collectToolCalls(entry: TreeNode['entry'], toolCalls: Map<string, { name: string; arguments: Record<string, unknown> }>): void {
  if (entry.type !== 'message' || entry.message?.role !== 'assistant') return
  const content = entry.message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type === 'toolCall' && typeof block.id === 'string') {
      toolCalls.set(block.id, {
        name: String(block.name ?? 'tool'),
        arguments: (block.arguments ?? {}) as Record<string, unknown>
      })
    }
  }
}

function kindOf(entry: TreeNode['entry']): SessionTreeRow['kind'] {
  const role = entry.message?.role
  if (entry.type === 'message' && role === 'user') return 'user'
  if (entry.type === 'message' && role === 'assistant') return 'assistant'
  if (entry.type === 'message' && (role === 'toolResult' || role === 'bashExecution')) return 'tool'
  return 'other'
}

function labelOf(
  entry: TreeNode['entry'],
  toolCalls: Map<string, { name: string; arguments: Record<string, unknown> }>
): string {
  if (entry.type === 'message') {
    const role = entry.message?.role
    if (role === 'user') return `user: ${extractContent(entry.message?.content)}`
    if (role === 'assistant') {
      const text = extractContent(entry.message?.content)
      if (text) return `assistant: ${text}`
      if (entry.message?.stopReason === 'aborted') return 'assistant: (aborted)'
      if (entry.message?.errorMessage) return `assistant: ${oneLine(entry.message.errorMessage, 80)}`
      return 'assistant: (no content)'
    }
    if (role === 'toolResult') {
      const call = entry.message?.toolCallId ? toolCalls.get(entry.message.toolCallId) : undefined
      return call ? formatToolCall(call.name, call.arguments) : `[${entry.message?.toolName ?? 'tool'}]`
    }
    if (role === 'bashExecution') return `[bash]: ${oneLine(entry.message?.command ?? '')}`
    return `[${role ?? 'message'}]`
  }
  if (entry.type === 'custom_message') return `[${entry.customType ?? 'custom'}]: ${extractContent(entry.message?.content)}`
  if (entry.type === 'compaction') {
    const tokens = Math.round((entry.tokensBefore ?? 0) / 1000)
    return `[compaction: ${tokens}k tokens]`
  }
  if (entry.type === 'branch_summary') return `[branch summary]: ${oneLine(entry.summary ?? '')}`
  return `[${entry.type}]`
}

type VisibleNode = {
  id: string
  parentId: string | null
  kind: SessionTreeRow['kind']
  text: string
  onPath: boolean
  current: boolean
  indent: number
  gutters: SessionTreeGutter[]
  showConnector: boolean
  isLast: boolean
  isVirtualRootChild: boolean
  foldable: boolean
}

function containsActiveMap(roots: TreeNode[], leafId: string | null): Map<string, boolean> {
  const containsActive = new Map<string, boolean>()
  const all: TreeNode[] = []
  const pre = [...roots]
  while (pre.length > 0) {
    const node = pre.pop()!
    all.push(node)
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i--) pre.push(children[i])
  }
  for (let i = all.length - 1; i >= 0; i--) {
    const node = all[i]
    let has = leafId !== null && node.entry.id === leafId
    for (const child of node.children ?? []) {
      if (containsActive.get(child.entry.id)) has = true
    }
    containsActive.set(node.entry.id, has)
  }
  return containsActive
}

function prioritizeActive(children: TreeNode[], containsActive: Map<string, boolean>): TreeNode[] {
  const onPath: TreeNode[] = []
  const rest: TreeNode[] = []
  for (const child of children) {
    if (containsActive.get(child.entry.id)) onPath.push(child)
    else rest.push(child)
  }
  return onPath.length ? [...onPath, ...rest] : children
}

function collectVisible(
  roots: TreeNode[],
  leafId: string | null,
  pathSet: Set<string>
): { visible: VisibleNode[]; parentOf: Map<string, string | null> } {
  const containsActive = containsActiveMap(roots, leafId)
  const parentOf = new Map<string, string | null>()
  const visible: VisibleNode[] = []
  const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>()
  const stack: { node: TreeNode; parentId: string | null }[] = []
  const orderedRoots = prioritizeActive(roots, containsActive)
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    stack.push({ node: orderedRoots[i], parentId: null })
  }

  while (stack.length > 0) {
    const { node, parentId } = stack.pop()!
    collectToolCalls(node.entry, toolCalls)
    parentOf.set(node.entry.id, parentId)
    const current = node.entry.id === leafId
    if (!hideInDefaultView(node.entry, current)) {
      visible.push({
        id: node.entry.id,
        parentId,
        kind: kindOf(node.entry),
        text: labelOf(node.entry, toolCalls),
        onPath: pathSet.has(node.entry.id),
        current,
        indent: 0,
        gutters: [],
        showConnector: false,
        isLast: true,
        isVirtualRootChild: false,
        foldable: false
      })
    }
    const children = prioritizeActive(node.children ?? [], containsActive)
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentId: node.entry.id })
    }
  }
  return { visible, parentOf }
}

function layoutVisible(visible: VisibleNode[], parentOf: Map<string, string | null>): void {
  if (visible.length === 0) return
  const visibleIds = new Set(visible.map((node) => node.id))
  const byId = new Map(visible.map((node) => [node.id, node]))
  const visibleParent = new Map<string, string | null>()
  const visibleChildren = new Map<string | null, string[]>()
  visibleChildren.set(null, [])

  const findVisibleAncestor = (id: string): string | null => {
    let currentId = parentOf.get(id) ?? null
    while (currentId) {
      if (visibleIds.has(currentId)) return currentId
      currentId = parentOf.get(currentId) ?? null
    }
    return null
  }

  for (const node of visible) {
    const ancestorId = findVisibleAncestor(node.id)
    visibleParent.set(node.id, ancestorId)
    node.parentId = ancestorId
    const list = visibleChildren.get(ancestorId) ?? []
    list.push(node.id)
    visibleChildren.set(ancestorId, list)
  }

  const rootIds = visibleChildren.get(null) ?? []
  const multipleRoots = rootIds.length > 1
  const stack: {
    id: string
    indent: number
    justBranched: boolean
    showConnector: boolean
    isLast: boolean
    gutters: SessionTreeGutter[]
    isVirtualRootChild: boolean
  }[] = []
  for (let i = rootIds.length - 1; i >= 0; i--) {
    stack.push({
      id: rootIds[i],
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      showConnector: multipleRoots,
      isLast: i === rootIds.length - 1,
      gutters: [],
      isVirtualRootChild: multipleRoots
    })
  }

  while (stack.length > 0) {
    const frame = stack.pop()!
    const node = byId.get(frame.id)
    if (!node) continue
    node.indent = frame.indent
    node.showConnector = frame.showConnector
    node.isLast = frame.isLast
    node.gutters = frame.gutters
    node.isVirtualRootChild = frame.isVirtualRootChild
    const children = visibleChildren.get(frame.id) ?? []
    const multipleChildren = children.length > 1
    const parentId = visibleParent.get(frame.id)
    node.foldable =
      children.length > 0 &&
      (parentId == null || (visibleChildren.get(parentId)?.length ?? 0) > 1)
    let childIndent = frame.indent
    if (multipleChildren) childIndent = frame.indent + 1
    else if (frame.justBranched && frame.indent > 0) childIndent = frame.indent + 1
    const connectorDisplayed = frame.showConnector && !frame.isVirtualRootChild
    const currentDisplayIndent = multipleRoots ? Math.max(0, frame.indent - 1) : frame.indent
    const connectorPosition = Math.max(0, currentDisplayIndent - 1)
    const childGutters = connectorDisplayed
      ? [...frame.gutters, { position: connectorPosition, show: !frame.isLast }]
      : frame.gutters
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({
        id: children[i],
        indent: childIndent,
        justBranched: multipleChildren,
        showConnector: multipleChildren,
        isLast: i === children.length - 1,
        gutters: childGutters,
        isVirtualRootChild: false
      })
    }
  }
}

/** The children structure the SDK builds from the same entries, orphans landing as roots. */
function treeOf(entries: SessionEntry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  for (const entry of entries) nodes.set(entry.id, { entry, children: [] })
  for (const entry of entries) {
    const node = nodes.get(entry.id)!
    const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId)
    if (entry.parentId === null || entry.parentId === entry.id || !parent) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}

export function sessionTreeRows(source: SessionSource): SessionTreeRow[] {
  const leafId = source.leafId()
  const pathSet = new Set(source.branchIds())
  const { visible, parentOf } = collectVisible(treeOf(source.treeEntries()), leafId, pathSet)
  layoutVisible(visible, parentOf)
  return visible.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    indent: node.indent,
    gutters: node.gutters,
    showConnector: node.showConnector,
    isLast: node.isLast,
    isVirtualRootChild: node.isVirtualRootChild,
    foldable: node.foldable,
    onPath: node.onPath,
    current: node.current,
    kind: node.kind,
    text: node.text
  }))
}
