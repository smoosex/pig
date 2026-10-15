/**
 * The right column: a worktree's files and its changes, one of the two at a time. The switcher keeps the
 * count of changed files in the tab that shows them, so the column says how much is waiting even while
 * the file tree is the one on screen.
 *
 * It shares the left sidebar's fixed width and keeps its contents mounted while the outer rail collapses
 * to zero. The inner rail stays full width, so collapsing either sidebar does not reflow its rows.
 *
 * The worktree watch belongs to the column rather than to the 变更 view: the file tree is refreshed from
 * the same events, and it runs only while the column is open.
 */
import { useEffect } from 'react'
import { retainWorktreeWatch, useDiffStore, type PanelTab } from '../../stores/diff'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { FileTree } from '../files/FileTree'
import { ChangesPanel } from '../diff/ChangesPanel'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { sidebarSurfaceToggle } from '../sidebar/sidebar-surface'

export function WorkspacePanel({ cwd, hidden = false }: { cwd: string; hidden?: boolean }) {
  const t = useT()
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
      className={cn(
        'flex min-w-0 overflow-hidden bg-transparent solid:bg-sidebar text-sidebar-foreground transition-[width,background-color] duration-200 ease-in-out motion-reduce:transition-none',
        hidden ? 'w-0' : 'w-62'
      )}
    >
      <div className="flex w-62 shrink-0 flex-col pr-2">
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
      </div>
    </aside>
  )
}
