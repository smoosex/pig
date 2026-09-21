/**
 * The change list inside the right column: what differs from HEAD right now, grouped the way git stages
 * it, with a flat 全部 view on top. Clicking a row opens the worktree's 全部变更 tab and reveals that file
 * there, so the column stays a list and the reading happens in the conversation area. Nothing here
 * mutates git, it only reads.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DiffFileEntry, DiffScope } from '../../ipc/api'
import { useDiffStore } from '../../stores/diff'
import { useSessionsStore } from '../../stores/sessions'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { SidebarHoverHighlight } from '../sidebar/SidebarHoverHighlight'
import { cn } from '../../lib/utils'
import { STATUS_META, fileIcon, splitPath, sumCounts } from './file-entry'

type Group = { key: 'staged' | 'unstaged'; label: string; entries: DiffFileEntry[] }

export function ChangesPanel({ cwd }: { cwd: string }) {
  const state = useDiffStore((s) => s.worktrees[cwd])
  const openChangesTab = useSessionsStore((s) => s.openChangesTab)
  // A primitive, because a fresh object on every render would loop zustand's store subscription.
  const changesActive = useSessionsStore((s) => s.openTabs.some((tab) => tab.id === s.activeTabId && tab.kind === 'diff'))
  // What the changes tab is showing right now, so the column marks the file being read.
  const visiblePath = useDiffStore((s) => s.visible[cwd])
  const [flat, setFlat] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const diff = state?.diff
  const groups: Group[] = [
    { key: 'staged', label: '已暂存', entries: diff?.staged ?? [] },
    { key: 'unstaged', label: '未提交', entries: diff?.unstaged ?? [] }
  ]
  const flatEntries = diff?.all ?? []

  function rows(entries: DiffFileEntry[], scope: DiffScope, indented: boolean) {
    // The left column's rhythm: 2px between rows, inset 4px so the hover background can round off.
    return (
      <div className="flex flex-col gap-0.5 px-1">
        {entries.map((entry) => row(entry, scope, indented))}
      </div>
    )
  }

  // The click carries the row's own group, so the canvas opens under the group the file was read in —
  // and the tab's title says which group that is.
  function row(entry: DiffFileEntry, scope: DiffScope, indented: boolean) {
    const meta = STATUS_META[entry.status]
    const Icon = fileIcon(entry.path)
    const { name, directory } = splitPath(entry.path)
    const isActive = changesActive && visiblePath === entry.path
    return (
      <button
        key={entry.path}
        type="button"
        title={entry.path}
        data-sidebar-hover-row
        onClick={() => void openChangesTab(cwd, entry.path, scope)}
        className={cn(
          'relative flex w-full items-center gap-1.5 rounded-sm py-1 pr-1 text-left text-xs transition-colors',
          // A grouped row starts where the group label does (4px inset + px-1 + chevron + gap), not
          // under the chevron; the flat list starts where the chevron of that label sits.
          indented ? 'pl-6' : 'pl-1',
          isActive && 'bg-sidebar-accent text-sidebar-accent-foreground'
        )}
      >
        <span className={cn('w-2.5 shrink-0 font-medium', meta.className)} aria-label={meta.label}>
          {meta.letter}
        </span>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-1/2 shrink-0 truncate">{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{directory}</span>
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
    if (!state) return <Notice>正在读取变更…</Notice>
    if (state.watchError) return <Notice>{state.watchError}</Notice>
    if (state.status === 'loading' && !state.diff) return <Notice>正在读取变更…</Notice>
    if (state.status === 'error') return <Notice>{state.error}</Notice>
    if (!diff?.git) return <Notice>当前目录不是 Git 仓库</Notice>
    if (!flatEntries.length) return <Notice>工作区没有未提交的变更</Notice>
    if (flat) return rows(flatEntries, 'all', false)
    return groups.map((group) => {
      if (!group.entries.length) return null
      // Counts are only known for what has been read: a group with an unknown file says its size and
      // nothing else, rather than adding up the half it happens to know.
      const counts = group.entries.every((entry) => entry.additions !== null) ? sumCounts(group.entries) : null
      const open = !collapsed[group.key]
      return (
        <div key={group.key}>
          <div className="sticky top-0 z-10 bg-sidebar px-1 has-[[data-sidebar-hover-target]]:bg-transparent">
            <button
              type="button"
              aria-expanded={open}
              data-sidebar-hover-row
              onClick={() => setCollapsed((current) => ({ ...current, [group.key]: open }))}
              className="relative flex w-full items-center gap-1.5 rounded-sm px-1 py-1.5 text-xs font-medium whitespace-nowrap transition-colors"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
              <span>{group.label}</span>
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarHoverHighlight>{list()}</SidebarHoverHighlight>
      </div>

      <footer className="flex shrink-0 items-center gap-2 px-2 pt-1.5 pb-2">
        <ToggleGroup
          type="single"
          size="xs"
          value={flat ? 'all' : 'grouped'}
          onValueChange={(value) => value && setFlat(value === 'all')}
          aria-label="变更列表分组方式"
        >
          <ToggleGroupItem value="grouped">分组</ToggleGroupItem>
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
        </ToggleGroup>
      </footer>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-xs text-muted-foreground">{children}</div>
}
