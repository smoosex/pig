/**
 * Left-rail filter list when the sidebar mode switch is on `kanban`:
 * - All issues (active count)
 * - Unassigned / Inbox (active count)
 * - Opened projects + any historical unopened project paths that still hold issues
 */
import { useMemo } from 'react'
import { FolderKanban, Inbox, Layers } from 'lucide-react'
import { isKanbanActiveStatus } from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { useKanbanStore } from '../../stores/kanban'
import { useSessionsStore } from '../../stores/sessions'
import { sidebarRowSurface } from '../sidebar/sidebar-surface'

export function KanbanSidebar() {
  const t = useT()
  const items = useKanbanStore((s) => s.items)
  const projectScope = useKanbanStore((s) => s.projectScope)
  const setProjectScope = useKanbanStore((s) => s.setProjectScope)
  const projects = useSessionsStore((s) => s.projects)

  const stats = useMemo(() => {
    let allActive = 0
    let unassignedActive = 0
    const byProject = new Map<string, number>()

    for (const item of items) {
      if (item.projectCwd && !byProject.has(item.projectCwd)) {
        byProject.set(item.projectCwd, 0)
      }
      if (!isKanbanActiveStatus(item.status)) continue
      allActive += 1
      if (!item.projectCwd) {
        unassignedActive += 1
      } else {
        byProject.set(item.projectCwd, (byProject.get(item.projectCwd) ?? 0) + 1)
      }
    }

    const openedSet = new Set(projects.map((p) => p.cwd))
    const closedCwds = [...byProject.keys()].filter((cwd) => !openedSet.has(cwd))

    return { allActive, unassignedActive, byProject, closedCwds }
  }, [items, projects])

  return (
    <div className="flex flex-col gap-0.5 py-1 pr-2">
      <button
        type="button"
        data-kanban-scope="all"
        onClick={() => setProjectScope('all')}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring',
          sidebarRowSurface(projectScope === 'all')
        )}
      >
        <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{t('kanban.allIssues')}</span>
        {stats.allActive > 0 ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{stats.allActive}</span>
        ) : null}
      </button>

      <button
        type="button"
        data-kanban-scope="unassigned"
        onClick={() => setProjectScope('unassigned')}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring',
          sidebarRowSurface(projectScope === 'unassigned')
        )}
      >
        <Inbox className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('kanban.unassigned')}</span>
        {stats.unassignedActive > 0 ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{stats.unassignedActive}</span>
        ) : null}
      </button>

      {projects.length > 0 || stats.closedCwds.length > 0 ? (
        <>
          <div className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
            {t('kanban.projectsHeader')}
          </div>
          {projects.map((project) => {
            const count = stats.byProject.get(project.cwd) ?? 0
            const selected = projectScope === project.cwd
            return (
              <button
                key={project.cwd}
                type="button"
                data-kanban-scope={project.cwd}
                onClick={() => setProjectScope(project.cwd)}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring',
                  sidebarRowSurface(selected)
                )}
                title={project.cwd}
              >
                <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {count > 0 ? (
                  <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{count}</span>
                ) : null}
              </button>
            )
          })}
          {stats.closedCwds.map((cwd) => {
            const count = stats.byProject.get(cwd) ?? 0
            const selected = projectScope === cwd
            return (
              <button
                key={cwd}
                type="button"
                data-kanban-scope={cwd}
                onClick={() => setProjectScope(cwd)}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-muted-foreground outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring',
                  sidebarRowSurface(selected)
                )}
                title={cwd}
              >
                <FolderKanban className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{baseName(cwd)}</span>
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]">
                  {t('kanban.unopenedProject')}
                </span>
                {count > 0 ? (
                  <span className="shrink-0 tabular-nums text-[11px]">{count}</span>
                ) : null}
              </button>
            )
          })}
        </>
      ) : null}
    </div>
  )
}
