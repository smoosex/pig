/**
 * The change review column: what differs from HEAD right now, grouped the way git stages it, with a
 * flat 全部 view on top. Clicking a row opens the worktree's 全部变更 tab and reveals that file there,
 * so the column stays a list and the reading happens in the conversation area. The panel owns the
 * worktree watch while it is open — nothing here mutates git, it only reads.
 *
 * It is a plain rail rather than a card: it sits on the same surface as the left sidebar, with only a
 * divided edge between it and the chat, and its rows keep that column's rhythm — inset, rounded hover
 * and 2px of air between them. Like that column it is always mounted and collapses by animating its
 * width to 0, so hiding it slides instead of popping; the worktree watch runs only while it is open.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DiffFileEntry, DiffScope } from '../../ipc/api'
import {
  MAX_REVIEW_WIDTH,
  MIN_REVIEW_WIDTH,
  retainWorktreeWatch,
  useDiffStore
} from '../../stores/diff'
import { useSessionsStore } from '../../stores/sessions'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { cn } from '../../lib/utils'
import { STATUS_META, fileIcon, splitPath, sumCounts } from './file-entry'

type Group = { key: 'staged' | 'unstaged'; label: string; entries: DiffFileEntry[] }

export function ReviewPanel({ cwd, hidden = false }: { cwd: string; hidden?: boolean }) {
  const state = useDiffStore((s) => s.worktrees[cwd])
  const width = useDiffStore((s) => s.reviewWidth)
  const setWidth = useDiffStore((s) => s.setReviewWidth)
  const commitWidth = useDiffStore((s) => s.commitReviewWidth)
  const openChangesTab = useSessionsStore((s) => s.openChangesTab)
  // A primitive, because a fresh object on every render would loop zustand's store subscription.
  const changesActive = useSessionsStore((s) => s.openTabs.some((tab) => tab.id === s.activeTabId && tab.kind === 'diff'))
  // What the changes tab is showing right now, so the column marks the file being read.
  const visiblePath = useDiffStore((s) => s.visible[cwd])
  const [flat, setFlat] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (hidden) return
    return retainWorktreeWatch(cwd)
  }, [cwd, hidden])

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
        onClick={() => void openChangesTab(cwd, entry.path, scope)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm py-1 pr-1 text-left text-xs transition-colors',
          // A grouped row starts where the group label does (4px inset + px-1 + chevron + gap), not
          // under the chevron; the flat list starts where the chevron of that label sits.
          indented ? 'pl-6' : 'pl-1',
          isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent'
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
          <div className="sticky top-0 z-10 bg-sidebar px-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setCollapsed((current) => ({ ...current, [group.key]: open }))}
              className="flex w-full items-center gap-1.5 rounded-sm px-1 py-1.5 text-xs font-medium whitespace-nowrap transition-colors hover:bg-sidebar-accent"
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
    <aside
      inert={hidden}
      aria-hidden={hidden}
      style={{ width: hidden ? 0 : width }}
      className={cn(
        'relative flex max-w-1/2 shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[width,margin] duration-200 ease-in-out motion-reduce:transition-none',
        hidden ? 'mr-0' : 'mr-2'
      )}
    >
      <ResizeHandle width={width} onResize={setWidth} onCommit={commitWidth} />
      {/* The 4px of air above the list lives here, not on the scroll region: sticky offsets resolve
          against the content box, so padding there both leaves an uncovered band that rows scroll
          through and makes the group label travel before it pins to the top. */}
      <header className="mb-1 flex h-9 shrink-0 items-center gap-2 pl-3 pr-1 whitespace-nowrap">
        <span className="text-xs font-medium">变更</span>
        <span className="text-xs tabular-nums text-muted-foreground">{flatEntries.length}</span>
        <span className="flex-1" />
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {list()}
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
    </aside>
  )
}

/** The column sits on the right edge, so a leftward drag widens it. */
function ResizeHandle({
  width,
  onResize,
  onCommit
}: {
  width: number
  onResize: (width: number) => void
  onCommit: () => void
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const finishDrag = () => {
    if (!drag.current) return
    drag.current = null
    onCommit()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整变更栏宽度"
      aria-valuenow={width}
      aria-valuemin={MIN_REVIEW_WIDTH}
      aria-valuemax={MAX_REVIEW_WIDTH}
      className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize"
      onPointerDown={(event) => {
        // The stored width can be capped by the layout, so a drag starts from what is on screen.
        const panel = event.currentTarget.parentElement
        drag.current = { startX: event.clientX, startWidth: panel?.offsetWidth ?? width }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const started = drag.current
        if (!started) return
        onResize(started.startWidth - (event.clientX - started.startX))
      }}
      onPointerUp={(event) => {
        finishDrag()
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
    />
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-2 text-xs text-muted-foreground">{children}</div>
}
