/**
 * The change list inside the right column: what differs from HEAD right now, grouped the way git stages
 * it, with a flat 全部 view on top; either can be drawn as a directory tree. Clicking a row opens the worktree's 全部变更 tab and reveals that file
 * there, so the column stays a list and the reading happens in the conversation area. Nothing here
 * mutates git, it only reads.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { scopeLabel } from '../../stores/diff'
import { useT } from '../../hooks/useT'
import { ChevronRight, Folder, FolderOpen, ListTree } from 'lucide-react'
import { Button } from '../ui/button'
import type { DiffFileEntry, DiffScope } from '../../ipc/api'
import { useDiffStore } from '../../stores/diff'
import { useSessionsStore } from '../../stores/sessions'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { sidebarRowSurface, sidebarSurfaceToggle } from '../sidebar/sidebar-surface'
import { changeTreeRows, type ChangeTreeRow } from './change-tree'
import { SidebarHoverHighlight } from '../sidebar/SidebarHoverHighlight'
import { cn } from '../../lib/utils'
import { FileTypeIcon } from '../files/FileTypeIcon'
import { STATUS_META, splitPath, sumCounts } from './file-entry'
import { fileDragProps } from '../composer/file-drag'

type Group = { key: 'staged' | 'unstaged'; entries: DiffFileEntry[] }

export function ChangesPanel({ cwd }: { cwd: string }) {
  const t = useT()
  const state = useDiffStore((s) => s.worktrees[cwd])
  const openChangesTab = useSessionsStore((s) => s.openChangesTab)
  // A primitive, because a fresh object on every render would loop zustand's store subscription.
  const changesActive = useSessionsStore((s) => s.openTabs.some((tab) => tab.id === s.activeTabId && tab.kind === 'diff'))
  // What the changes tab is showing right now, so the column marks the file being read.
  const visiblePath = useDiffStore((s) => s.visible[cwd])
  const [flat, setFlat] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [tree, setTree] = useState(false)
  // Keyed by scope and path, so the same directory folds separately under 已暂存 and 未暂存.
  const [treeCollapsed, setTreeCollapsed] = useState<Record<string, boolean>>({})
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const diff = state?.diff
  const groups: Group[] = [
    { key: 'staged', entries: diff?.staged ?? [] },
    { key: 'unstaged', entries: diff?.unstaged ?? [] }
  ]
  const flatEntries = diff?.all ?? []

  useLayoutEffect(() => {
    const area = scrollAreaRef.current!
    const sections = [...area.querySelectorAll<HTMLElement>('[data-change-group]')]
    // Headers expose the column surface and shared hover layer; bottom padding keeps the gap inside the clip boundary.
    // Read all bounds before clipping; this does not change layout or rerender React on scroll.
    const updateClips = () => {
      const clips = sections.flatMap((section) => {
        const header = section.firstElementChild as HTMLElement
        const list = header.nextElementSibling as HTMLElement | null
        if (!list) return []
        return [{
          list,
          top: Math.max(0, header.getBoundingClientRect().bottom - list.getBoundingClientRect().top)
        }]
      })
      for (const { list, top } of clips) {
        list.style.clipPath = top > 0 ? `inset(${top}px 0 0)` : ''
      }
    }
    const observer = new ResizeObserver(updateClips)
    observer.observe(area)
    for (const section of sections) observer.observe(section)
    area.addEventListener('scroll', updateClips, { passive: true })
    updateClips()
    return () => {
      area.removeEventListener('scroll', updateClips)
      observer.disconnect()
    }
  }, [collapsed, cwd, flat, state, tree, treeCollapsed])

  function rows(entries: DiffFileEntry[], scope: DiffScope, indented: boolean) {
    // The left column's rhythm: 2px between rows, inset 4px so the hover background can round off.
    return (
      <div className="flex flex-col gap-0.5 px-1">
        {tree
          ? changeTreeRows(entries, (path) => treeCollapsed[`${scope}\u0000${path}`] === true).map((item) =>
              treeRow(item, scope, indented)
            )
          : entries.map((entry) => row(entry, scope, indented))}
      </div>
    )
  }

  // A tree row carries its indent itself, like the file column's, so the hover background spans the column.
  // The base matches the list rows: under the group label's text when grouped, under its chevron when flat.
  function treeRow(item: ChangeTreeRow, scope: DiffScope, indented: boolean) {
    const indent = { paddingInlineStart: `${(indented ? 24 : 4) + item.depth * 12}px` }
    if (item.kind === 'file') return row(item.entry, scope, indented, indent)
    const key = `${scope}\u0000${item.path}`
    const counts = item.entries.every((entry) => entry.additions !== null) ? sumCounts(item.entries) : null
    return (
      <button
        key={`directory\u0000${item.path}`}
        type="button"
        title={item.path}
        aria-expanded={item.open}
        data-sidebar-hover-row
        style={indent}
        onClick={() => setTreeCollapsed((current) => ({ ...current, [key]: item.open }))}
        className={cn(
          'relative flex w-full items-center gap-1.5 rounded-sm py-1 pr-1 text-left text-xs',
          sidebarRowSurface(false)
        )}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', item.open && 'rotate-90')} />
        {item.open ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        {counts ? (
          <>
            <span className="shrink-0 tabular-nums text-success">+{counts.additions}</span>
            <span className="shrink-0 tabular-nums text-destructive">-{counts.deletions}</span>
          </>
        ) : null}
      </button>
    )
  }

  // The click carries the row's own group, so the canvas opens under the group the file was read in —
  // and the tab's title says which group that is.
  // In the tree the directory is the row above, so a tree row passes its indent and drops the path.
  function row(entry: DiffFileEntry, scope: DiffScope, indented: boolean, indent?: React.CSSProperties) {
    const meta = STATUS_META[entry.status]
    const { name, directory } = splitPath(entry.path)
    const isActive = changesActive && visiblePath === entry.path
    return (
      <button
        key={entry.path}
        type="button"
        title={entry.path}
        data-sidebar-hover-row
        data-sidebar-selected={isActive || undefined}
        style={indent}
        // A deleted file has nothing left on disk for the mention to point at.
        {...(entry.status === 'deleted' ? {} : fileDragProps({ cwd, path: entry.path, isDirectory: false }))}
        onClick={() => void openChangesTab(cwd, entry.path, scope)}
        className={cn(
          'relative flex w-full items-center gap-1.5 rounded-sm py-1 pr-1 text-left text-xs',
          sidebarRowSurface(isActive),
          // A grouped row starts where the group label does (4px inset + px-1 + chevron + gap), not
          // under the chevron; the flat list starts where the chevron of that label sits.
          indented ? 'pl-6' : 'pl-1',
          isActive && 'text-sidebar-accent-foreground'
        )}
      >
        {/* As wide as a directory's chevron in the tree, so a file's icon lines up under its sibling folders'. */}
        <span
          className={cn('shrink-0 font-medium', indent ? 'w-3.5 text-center' : 'w-2.5', meta.className)}
          aria-label={t(meta.labelKey)}
        >
          {meta.letter}
        </span>
        <FileTypeIcon path={entry.path} className="size-3.5 shrink-0 text-muted-foreground" />
        {indent ? (
          <span className="min-w-0 flex-1 truncate">{name}</span>
        ) : (
          <>
            <span className="max-w-1/2 shrink-0 truncate">{name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{directory}</span>
          </>
        )}
        {entry.additions === null ? null : (
          <span className="shrink-0 tabular-nums text-success">+{entry.additions}</span>
        )}
        {entry.deletions === null ? null : (
          <span className="shrink-0 tabular-nums text-destructive">-{entry.deletions}</span>
        )}
      </button>
    )
  }

  function list() {
    // A refresh keeps the list that is already there: the loading text is only for the first read.
    if (!state) return <Notice>{t('diff.reading')}</Notice>
    if (state.watchError) return <Notice>{state.watchError}</Notice>
    if (state.status === 'loading' && !state.diff) return <Notice>{t('diff.reading')}</Notice>
    if (state.status === 'error') return <Notice>{state.error}</Notice>
    if (!diff?.git) return <Notice>{t('diff.notGit')}</Notice>
    if (!flatEntries.length) return <Notice>{t('diff.emptyWorktree')}</Notice>
    if (flat) return rows(flatEntries, 'all', false)
    return groups.map((group) => {
      if (!group.entries.length) return null
      // Counts are only known for what has been read: a group with an unknown file says its size and
      // nothing else, rather than adding up the half it happens to know.
      const counts = group.entries.every((entry) => entry.additions !== null) ? sumCounts(group.entries) : null
      const open = !collapsed[group.key]
      return (
        <div key={group.key} data-change-group={group.key}>
          <div data-sidebar-hover-occlusion className={cn('sticky top-0 z-10 bg-transparent px-1', open && 'pb-0.5')}>
            <button
              type="button"
              aria-expanded={open}
              data-sidebar-hover-row
              onClick={() => setCollapsed((current) => ({ ...current, [group.key]: open }))}
              className={cn(
                'relative flex w-full items-center gap-1.5 rounded-sm px-1 py-1.5 text-xs font-medium whitespace-nowrap',
                sidebarRowSurface(false)
              )}
            >
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
              <span>{scopeLabel(t, group.key)}</span>
              <span className="tabular-nums text-muted-foreground">({group.entries.length})</span>
              <span className="flex-1" />
              {counts ? (
                <>
                  <span className="tabular-nums text-success">+{counts.additions}</span>
                  <span className="tabular-nums text-destructive">-{counts.deletions}</span>
                </>
              ) : null}
            </button>
          </div>
          {open ? rows(group.entries, group.key, true) : null}
        </div>
      )
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The 4px of air above the list lives here, not on the scroll region: sticky offsets resolve
          against the content box, so padding there both leaves an uncovered band that rows scroll
          through and makes the group label travel before it pins to the top. */}
      <div ref={scrollAreaRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarHoverHighlight className="flex flex-col gap-0.5">{list()}</SidebarHoverHighlight>
      </div>

      <footer className="flex shrink-0 items-center gap-2 px-2 pt-1.5 pb-2">
        <ToggleGroup
          type="single"
          size="xs"
          value={flat ? 'all' : 'grouped'}
          onValueChange={(value) => value && setFlat(value === 'all')}
          aria-label={t('diff.groupsAria')}
        >
          <ToggleGroupItem value="grouped" className={sidebarSurfaceToggle}>
            {t('diff.group')}
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className={sidebarSurfaceToggle}>
            {t('diff.flat')}
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn('text-muted-foreground', sidebarSurfaceToggle)}
          aria-pressed={tree}
          aria-label={t('diff.treeView')}
          title={t('diff.treeView')}
          onClick={() => setTree(!tree)}
        >
          <ListTree />
        </Button>
      </footer>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-xs text-muted-foreground">{children}</div>
}
