import { useEffect, useId, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertCircle, ChevronRight, FolderInput, FolderMinus, FolderOutput, FolderSearch, MoreHorizontal, PenLine, Plus } from 'lucide-react'
import { baseName } from '../../../../shared/paths'
import { resolveProjectSpaceId } from '../../../../shared/project-spaces'
import { spaceDisplayName, useProjectSpacesStore } from '../../stores/project-spaces'
import { useSessionsStore, selectActiveSessionCwd, type ProjectGroup, type WorktreeGroup } from '../../stores/sessions'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
import { cn, hideScroll } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { useT } from '../../hooks/useT'
import { useProjectAction } from './project-action'
import { CreateWorktreeButton } from './WorktreeActions'
import { WorktreeRow } from './WorktreeRow'
import { ProjectAvatar } from './ProjectAvatar'
import { sidebarButtonSurface, sidebarRowSurface } from './sidebar-surface'
import { SpaceGlyph } from './space-icons'

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
  const renameProject = useSessionsStore((s) => s.renameProject)
  const openRelocateProjectDialog = useSessionsStore((s) => s.openRelocateProjectDialog)
  const openMoveProjectDialog = useSessionsStore((s) => s.openMoveProjectDialog)
  const unpinProject = useSessionsStore((s) => s.unpinProject)
  const open = useSessionsStore((s) => s.expandedProjects[project.cwd] ?? false)
  const expandedWorktrees = useSessionsStore((s) => s.expandedWorktrees)
  const setProjectExpanded = useSessionsStore((s) => s.setProjectExpanded)
  const setWorktreeExpanded = useSessionsStore((s) => s.setWorktreeExpanded)
  const revealProjectWorktree = useSessionsStore((s) => s.revealProjectWorktree)
  const spaces = useProjectSpacesStore((s) => s.spaces)
  const assignments = useProjectSpacesStore((s) => s.assignments)
  const assignProject = useProjectSpacesStore((s) => s.assignProject)
  const openSpaceDialog = useProjectSpacesStore((s) => s.openDialog)
  const currentSpaceId = resolveProjectSpaceId({ spaces, assignments }, project.cwd)
  const t = useT()
  const renameInputId = useId()
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const { pending, error, runAction } = useProjectAction()

  const folderName = baseName(project.cwd) || project.cwd
  const openRename = () => {
    setRenameValue(project.customName ?? project.name)
    setRenameError(null)
    setRenameOpen(true)
  }
  const submitRename = async () => {
    if (renaming) return
    setRenaming(true)
    setRenameError(null)
    try {
      await renameProject(project.cwd, renameValue)
      setRenameOpen(false)
    } catch (failure) {
      setRenameError(failureMessage(failure))
    } finally {
      setRenaming(false)
    }
  }
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
          <ContextMenu>
            <ContextMenuTrigger asChild>
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
                    className={cn('h-full min-w-0 flex-1 justify-start gap-1.5 rounded-md px-0 text-xs font-normal', sidebarButtonSurface)}
                    onClick={(event) => {
                      if (clickGuard.current) {
                        event.preventDefault()
                        event.stopPropagation()
                      }
                    }}
                  >
                    <ProjectAvatar name={project.name} index={index} />
                    <span className={cn('min-w-0 truncate', project.missing && 'text-muted-foreground')} title={project.cwd}>
                      {project.name}
                    </span>
                    {project.missing ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex shrink-0 text-destructive">
                            <AlertCircle className="size-3.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64 break-all">
                          {t('project.missingHint', { cwd: project.cwd })}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
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
                      className={cn(
                        'pointer-events-none text-muted-foreground opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
                        sidebarButtonSurface
                      )}
                      aria-label={t('project.menu', { name: project.name })}
                      disabled={pending !== null}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem disabled={pending !== null} onSelect={openRename}>
                        <PenLine data-icon="inline-start" />
                        {t('project.rename')}
                      </DropdownMenuItem>
                      {!project.missing ? (
                        <DropdownMenuItem
                          disabled={pending !== null}
                          onSelect={() => openMoveProjectDialog({ cwd: project.cwd, name: project.name })}
                        >
                          <FolderOutput data-icon="inline-start" />
                          {t('project.moveLocation')}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        disabled={pending !== null}
                        onSelect={() => openRelocateProjectDialog({ cwd: project.cwd, name: project.name })}
                      >
                        <FolderSearch data-icon="inline-start" />
                        {t('project.relocate')}
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <FolderInput data-icon="inline-start" />
                          {t('project.moveToSpace')}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuPortal>
                          <DropdownMenuSubContent className={cn('max-h-52 overflow-y-auto', hideScroll)}>
                            <DropdownMenuRadioGroup
                              value={currentSpaceId}
                              onValueChange={(spaceId) => void assignProject(project.cwd, spaceId)}
                            >
                              {spaces.map((space) => (
                                <DropdownMenuRadioItem key={space.id} value={space.id}>
                                  <span className="flex size-3 shrink-0 items-center justify-center">
                                    <SpaceGlyph icon={space.icon} active={space.id === currentSpaceId} />
                                  </span>
                                  <span className="min-w-0 truncate">{spaceDisplayName(space, t)}</span>
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => openSpaceDialog({ mode: 'create', moveProjectCwd: project.cwd })}
                            >
                              <Plus data-icon="inline-start" />
                              {t('project.newSpaceAndMove')}
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuPortal>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={pending !== null}
                        onSelect={() => void runAction('unpin', () => unpinProject(project.cwd))}
                      >
                        <FolderMinus data-icon="inline-start" />
                        {t('project.remove')}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <CreateWorktreeButton
                  projectCwd={project.cwd}
                  hasGit={project.hasGit === true}
                  disabled={pending !== null || Boolean(project.missing)}
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
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuGroup>
                <ContextMenuItem disabled={pending !== null} onSelect={openRename}>
                  <PenLine data-icon="inline-start" />
                  {t('project.rename')}
                </ContextMenuItem>
                {!project.missing ? (
                  <ContextMenuItem
                    disabled={pending !== null}
                    onSelect={() => openMoveProjectDialog({ cwd: project.cwd, name: project.name })}
                  >
                    <FolderOutput data-icon="inline-start" />
                    {t('project.moveLocation')}
                  </ContextMenuItem>
                ) : null}
                <ContextMenuItem
                  disabled={pending !== null}
                  onSelect={() => openRelocateProjectDialog({ cwd: project.cwd, name: project.name })}
                >
                  <FolderSearch data-icon="inline-start" />
                  {t('project.relocate')}
                </ContextMenuItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <FolderInput data-icon="inline-start" />
                    {t('project.moveToSpace')}
                  </ContextMenuSubTrigger>
                  <ContextMenuPortal>
                    <ContextMenuSubContent className={cn('max-h-52 overflow-y-auto', hideScroll)}>
                      <ContextMenuRadioGroup
                        value={currentSpaceId}
                        onValueChange={(spaceId) => void assignProject(project.cwd, spaceId)}
                      >
                        {spaces.map((space) => (
                          <ContextMenuRadioItem key={space.id} value={space.id}>
                            <span className="flex size-3 shrink-0 items-center justify-center">
                              <SpaceGlyph icon={space.icon} active={space.id === currentSpaceId} />
                            </span>
                            <span className="min-w-0 truncate">{spaceDisplayName(space, t)}</span>
                          </ContextMenuRadioItem>
                        ))}
                      </ContextMenuRadioGroup>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => openSpaceDialog({ mode: 'create', moveProjectCwd: project.cwd })}
                      >
                        <Plus data-icon="inline-start" />
                        {t('project.newSpaceAndMove')}
                      </ContextMenuItem>
                    </ContextMenuSubContent>
                  </ContextMenuPortal>
                </ContextMenuSub>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={pending !== null}
                  onSelect={() => void runAction('unpin', () => unpinProject(project.cwd))}
                >
                  <FolderMinus data-icon="inline-start" />
                  {t('project.remove')}
                </ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
          {project.missing && (
            <div className="flex items-center justify-between gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 truncate" title={project.cwd}>
                {t('project.missingHint', { cwd: folderName })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={pending !== null}
                onClick={() => openRelocateProjectDialog({ cwd: project.cwd, name: project.name })}
              >
                <FolderSearch data-icon="inline-start" />
                {t('project.relocateShort')}
              </Button>
            </div>
          )}
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
        <Dialog open={renameOpen} onOpenChange={(next) => { if (!renaming) setRenameOpen(next) }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">{t('project.renameTitle')}</DialogTitle>
              <DialogDescription className="text-xs">
                {t('project.renameDescription', { folder: folderName })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={renameInputId} className="text-xs">
                {t('project.renameLabel')}
              </Label>
              <Input
                id={renameInputId}
                value={renameValue}
                placeholder={folderName}
                maxLength={120}
                disabled={renaming}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) {
                    event.preventDefault()
                    void submitRename()
                  }
                }}
              />
              {renameError ? (
                <p role="alert" className="text-xs text-destructive">
                  {renameError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={renaming} onClick={() => setRenameOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button disabled={renaming} onClick={() => void submitRename()}>
                {t('project.renameSave')}
              </Button>
            </DialogFooter>
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
