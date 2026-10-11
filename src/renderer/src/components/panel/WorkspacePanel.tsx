/**
 * The right column: a worktree's files and its changes, one of the two at a time. The switcher keeps the
 * count of changed files in the tab that shows them, so the column says how much is waiting even while
 * the file tree is the one on screen.
 *
 * It is a plain rail rather than a card: it sits on the same surface as the left sidebar, with only a
 * divided edge between it and the conversation, and its rows keep that column's rhythm — inset, rounded
 * hover and 2px of air between them. Like that column it is always mounted and collapses by animating its
 * width to 0, so hiding it slides instead of popping.
 *
 * The worktree watch belongs to the column rather than to the 变更 view: the file tree is refreshed from
 * the same events, and it runs only while the column is open.
 */
import { useEffect, useRef } from 'react'
import {
  MAX_REVIEW_WIDTH,
  MIN_REVIEW_WIDTH,
  retainWorktreeWatch,
  useDiffStore,
  type PanelTab
} from '../../stores/diff'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { FileTree } from '../files/FileTree'
import { ChangesPanel } from '../diff/ChangesPanel'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'

const sidebarSurfaceToggle = 'hover:bg-sidebar-accent data-[state=on]:bg-sidebar-accent'

export function WorkspacePanel({ cwd, hidden = false }: { cwd: string; hidden?: boolean }) {
  const t = useT()
  const width = useDiffStore((s) => s.reviewWidth)
  const setWidth = useDiffStore((s) => s.setReviewWidth)
  const commitWidth = useDiffStore((s) => s.commitReviewWidth)
  const tab = useDiffStore((s) => s.panelTab[cwd] ?? 'changes')
  const setPanelTab = useDiffStore((s) => s.setPanelTab)
  const changed = useDiffStore((s) => s.worktrees[cwd]?.diff?.all.length ?? null)

  useEffect(() => {
    if (hidden) return
    return retainWorktreeWatch(cwd)
  }, [cwd, hidden])

  return (
    <aside
      inert={hidden}
      aria-hidden={hidden}
      style={{ width: hidden ? 0 : width }}
      className={cn(
        'relative flex min-w-0 max-w-1/2 flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[width,margin] duration-200 ease-in-out motion-reduce:transition-none',
        hidden ? 'mr-0' : 'mr-2'
      )}
    >
      <ResizeHandle width={width} onResize={setWidth} onCommit={commitWidth} />
      <header className="mb-1 flex h-9 shrink-0 items-center gap-2 pr-1 pl-1.5 whitespace-nowrap">
        <ToggleGroup
          type="single"
          size="xs"
          value={tab}
          onValueChange={(value) => value && setPanelTab(cwd, value as PanelTab)}
          aria-label={t('panel.viewAria')}
        >
          <ToggleGroupItem value="files" className={sidebarSurfaceToggle}>
            {t('panel.files')}
          </ToggleGroupItem>
          <ToggleGroupItem value="changes" className={sidebarSurfaceToggle}>
            {t('panel.changes')}
            {changed === null ? null : (
              <span className="tabular-nums text-muted-foreground">{changed}</span>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="flex-1" />
      </header>

      {tab === 'files' ? <FileTree cwd={cwd} /> : <ChangesPanel cwd={cwd} />}
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
  const t = useT()
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
      aria-label={t('panel.resizeAria')}
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
