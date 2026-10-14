import { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRight, FolderMinus, MoreHorizontal, Trash2 } from 'lucide-react'
import { useSessionsStore, selectActiveSessionCwd, type ProjectGroup, type WorktreeGroup } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { useT } from '../../hooks/useT'
import { useProjectAction } from './project-action'
import { CreateWorktreeButton } from './WorktreeActions'
import { WorktreeRow } from './WorktreeRow'
import { ProjectAvatar } from './ProjectAvatar'
import { sidebarRowSurface } from './sidebar-surface'

export type DragClickGuard = { current: boolean }

export function ProjectRow({
  project,
  index,
  disabled,
  clickGuard
}: {
  project: ProjectGroup
  index: number
  disabled: boolean
  clickGuard: DragClickGuard
}) {
  const createWorktree = useSessionsStore((s) => s.createWorktree)
  const newSession = useSessionsStore((s) => s.newSession)
  const deleteProject = useSessionsStore((s) => s.deleteProject)
  const unpinProject = useSessionsStore((s) => s.unpinProject)
  const open = useSessionsStore((s) => s.expandedProjects[project.cwd] ?? false)
  const expandedWorktrees = useSessionsStore((s) => s.expandedWorktrees)
  const setProjectExpanded = useSessionsStore((s) => s.setProjectExpanded)
  const setWorktreeExpanded = useSessionsStore((s) => s.setWorktreeExpanded)
  const revealProjectWorktree = useSessionsStore((s) => s.revealProjectWorktree)
  const t = useT()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { pending, error, runAction } = useProjectAction()
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: project.cwd, disabled })
  const worktrees: WorktreeGroup[] = project.worktrees ?? [
    {
      cwd: project.cwd,
      branch: project.name,
      isPrimary: true,
      locked: false,
      missing: false,
      managed: false,
      sessions: project.sessions
    }
  ]
  const active = useSessionsStore((s) =>
    worktrees.some((worktree) => worktree.cwd === s.currentProjectCwd)
  )
  const activeSessionCwd = useSessionsStore(selectActiveSessionCwd)
  const revealedCwd =
    activeSessionCwd !== null && worktrees.some((worktree) => worktree.cwd === activeSessionCwd)
      ? activeSessionCwd
      : null
  useEffect(() => {
    revealProjectWorktree(project.cwd, revealedCwd)
  }, [revealedCwd, project.cwd, revealProjectWorktree])

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-40')}
    >
      <Collapsible open={open} onOpenChange={(next) => setProjectExpanded(project.cwd, next)}>
        <div className="px-1">
          <div
            data-sidebar-hover-row
            data-sidebar-selected={active || undefined}
            className={cn(
              'group/project relative flex h-9 items-center gap-0.5 rounded-md px-1',
              sidebarRowSurface(active)
            )}
          >
            <CollapsibleTrigger asChild>
              <Button
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                variant="ghost"
                className="h-full min-w-0 flex-1 justify-start gap-1.5 rounded-md px-0 text-xs font-normal !bg-transparent"
                onClick={(event) => {
                  if (clickGuard.current) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                }}
              >
                <ProjectAvatar name={project.name} index={index} />
                <span className="min-w-0 truncate" title={project.cwd}>
                  {project.name}
                </span>
                <ChevronRight
                  className={cn(
                    'size-2.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/project:opacity-100 group-focus-within/project:opacity-100',
                    open && 'rotate-90'
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="pointer-events-none opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
                  aria-label={t('project.menu', { name: project.name })}
                  disabled={pending !== null}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={pending !== null}
                    onSelect={() => void runAction('unpin', () => unpinProject(project.cwd))}
                  >
                    <FolderMinus data-icon="inline-start" />
                    {t('project.remove')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending !== null}
                    onSelect={() => setDeleteOpen(true)}
                  >
                    <Trash2 data-icon="inline-start" />
                    {t('project.delete')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <CreateWorktreeButton
              projectCwd={project.cwd}
              hasGit={project.hasGit === true}
              disabled={pending !== null}
              busy={pending === 'create-worktree'}
              runAction={runAction}
              onCreate={async (initGit) => {
                const cwd = await createWorktree(project.cwd, { initGit })
                if (!cwd) return
                setProjectExpanded(project.cwd, true)
                setWorktreeExpanded(cwd, true)
                await newSession(cwd)
              }}
            />
          </div>
          {project.gitError && (
            <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">
              {project.gitError}
            </p>
          )}
          {error && (
            <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">
              {error}
            </p>
          )}
        </div>
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-sm">{t('project.delete')}</DialogTitle>
              <DialogDescription className="text-xs">{t('project.deleteBody')}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={pending !== null}
                onClick={() => {
                  setDeleteOpen(false)
                  void runAction('delete-project', () => deleteProject(project.cwd))
                }}
              >
                {t('project.deleteConfirm')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <CollapsibleContent>
          <div className="flex flex-col gap-0.5 pt-0.5 pb-1">
            {worktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.cwd}
                projectCwd={project.cwd}
                worktree={worktree}
                open={expandedWorktrees[worktree.cwd] ?? false}
                onOpenChange={(value) => setWorktreeExpanded(worktree.cwd, value)}
                pending={pending}
                runAction={runAction}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
