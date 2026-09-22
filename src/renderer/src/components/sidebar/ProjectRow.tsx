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
import { useProjectAction } from './project-action'
import { CreateWorktreeButton } from './WorktreeActions'
import { WorktreeRow } from './WorktreeRow'
import { ProjectAvatar } from './ProjectAvatar'

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
  const [open, setOpen] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState<Record<string, boolean>>({})
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
  // The strip follows the session: opening or switching to one unfolds its project and branch here.
  // Only ever unfolding, so a branch the user folded stays folded until another session asks for it.
  useEffect(() => {
    if (revealedCwd === null) return
    setOpen(true)
    setWorktreeOpen((state) => (state[revealedCwd] ? state : { ...state, [revealedCwd]: true }))
  }, [revealedCwd])

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-40')}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="px-1">
          <div
            data-sidebar-hover-row
            className={cn(
              'group/project relative flex h-9 items-center gap-0.5 rounded-md px-1 transition-colors',
              active && 'bg-sidebar-accent'
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
                  aria-label={`项目 ${project.name} 更多操作`}
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
                    从列表移除
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending !== null}
                    onSelect={() => setDeleteOpen(true)}
                  >
                    <Trash2 data-icon="inline-start" />
                    删除项目
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
                setOpen(true)
                setWorktreeOpen((state) => ({ ...state, [cwd]: true }))
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
              <DialogTitle className="text-sm">删除项目</DialogTitle>
              <DialogDescription className="text-xs">
                将停止并删除原目录及所有 Worktree 的 Pi 会话，并从项目列表移除。项目文件、Worktree
                和 Git 分支会保留。会话删除后无法恢复。
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={pending !== null}
                onClick={() => {
                  setDeleteOpen(false)
                  void runAction('delete-project', () => deleteProject(project.cwd))
                }}
              >
                删除会话并移除
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
                open={worktreeOpen[worktree.cwd] ?? false}
                onOpenChange={(value) =>
                  setWorktreeOpen((state) => ({ ...state, [worktree.cwd]: value }))
                }
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
