/** Scope-qualified memory paths form a display-only tree; selection keeps the canonical path. */
import { useMemo, useState } from 'react'
import type { MemoryFileListItem } from '../../../../shared/long-term-memory'
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import { cn } from '../../lib/utils'
import { SidebarHoverHighlight } from '../sidebar/SidebarHoverHighlight'
import { sidebarButtonSurface, sidebarRowSurface } from '../sidebar/sidebar-surface'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

type MemoryNode = { name: string; label?: string; path: string; children: Map<string, MemoryNode> }
type TreeActions = { selected?: string; disabled: boolean; onSelect: (path: string) => void }

function memoryTree(files: MemoryFileListItem[]): Map<string, MemoryNode> {
  const root = new Map<string, MemoryNode>()
  for (const { path, projectName } of files) {
    const parts = path.split('/')
    let children = root
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]
      let node = children.get(name)
      if (!node) {
        node = { name, path: parts.slice(0, index + 1).join('/'), children: new Map() }
        children.set(name, node)
      }
      if (index === 1 && parts[0] === 'projects' && projectName) node.label = `${projectName} (${name})`
      children = node.children
    }
  }
  return root
}

function sorted(nodes: Map<string, MemoryNode>): MemoryNode[] {
  return [...nodes.values()].sort((a, b) => Number(b.children.size > 0) - Number(a.children.size > 0) || (a.label ?? a.name).localeCompare(b.label ?? b.name))
}

function MemoryBranch({ node, depth, ...actions }: TreeActions & { node: MemoryNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0)
  const directory = node.children.size > 0
  const selected = !directory && actions.selected === node.path
  const row = <Button variant="ghost" size="sm" disabled={actions.disabled} title={node.path}
    data-sidebar-hover-row data-sidebar-selected={selected || undefined}
    aria-pressed={directory ? undefined : selected}
    style={{ paddingInlineStart: 4 + depth * 12 }}
    className={cn('w-full min-w-0 justify-start gap-1.5 text-xs', sidebarRowSurface(selected), directory && sidebarButtonSurface)}
    onClick={directory ? undefined : () => actions.onSelect(node.path)}>
    {directory ? <ChevronRight aria-hidden="true" className={cn('shrink-0 transition-transform', open && 'rotate-90')} /> : <span className="size-3.5 shrink-0" />}
    {directory ? open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />}
    <span className="truncate">{node.label ?? node.name}</span>
  </Button>
  return directory ? <Collapsible open={open} onOpenChange={setOpen} disabled={actions.disabled} className="min-w-0">
    <CollapsibleTrigger asChild>{row}</CollapsibleTrigger>
    <CollapsibleContent>
      {sorted(node.children).map(child => <MemoryBranch key={child.path} node={child} depth={depth + 1} {...actions} />)}
    </CollapsibleContent>
  </Collapsible> : row
}

export function MemoryFileTree({ files, ...actions }: TreeActions & { files: MemoryFileListItem[] }) {
  const nodes = useMemo(() => memoryTree(files), [files])
  return <SidebarHoverHighlight className="flex min-w-0 flex-col gap-0.5" data-memory-file-tree>
    {sorted(nodes).map(node => <MemoryBranch key={node.path} node={node} depth={0} {...actions} />)}
  </SidebarHoverHighlight>
}
