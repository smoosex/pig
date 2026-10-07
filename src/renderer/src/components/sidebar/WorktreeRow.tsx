import { useMemo } from 'react'
import { AlertCircle, ChevronRight, LoaderCircle, LockKeyhole, Plus, RefreshCw } from 'lucide-react'
import { api } from '../../ipc/api'
import { useSessionsStore, type WorktreeGroup } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { WorktreeDeleteButton } from './WorktreeActions'
import { SessionList } from './SessionList'
import { SessionHistoryPopover } from '../SessionHistoryPopover'
import type { RunProjectAction } from './project-action'
import { useT } from '../../hooks/useT'

export function WorktreeRow({
  projectCwd,
  worktree,
  open,
  onOpenChange,
  pending,
  runAction
}: {
  projectCwd: string
  worktree: WorktreeGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: string | null
  runAction: RunProjectAction
}) {
  const newSession = useSessionsStore((s) => s.newSession)
  const deleteWorktree = useSessionsStore((s) => s.deleteWorktree)
  const selectProjectCwd = useSessionsStore((s) => s.selectProjectCwd)
  const openTabs = useSessionsStore((s) => s.openTabs)
  const t = useT()
  const sessions = useMemo(
    () => openTabs.filter((tab) => tab.kind === 'project' && tab.cwd === worktree.cwd),
    [openTabs, worktree.cwd]
  )
  const active = useSessionsStore((s) => s.currentProjectCwd === worktree.cwd)
  const namingLabel =
    worktree.naming === 'pending'
      ? t('worktree.namingPending')
      : worktree.naming === 'naming'
        ? t('worktree.naming')
        : null
  const retrying = pending === `retry-naming:${worktree.cwd}`
  const branchButton = (
    <Button
      variant="ghost"
      size="xs"
      className="h-full min-w-0 flex-1 justify-start gap-1 rounded-md px-0 text-xs font-normal !bg-transparent"
      aria-label={namingLabel ? t('worktree.branchNaming', { branch: worktree.branch, state: namingLabel }) : worktree.branch}
      onClick={() => void selectProjectCwd(worktree.cwd)}
    >
      <ChevronRight
        className={cn(
          'size-2.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100',
          open && 'rotate-90',
          sessions.length === 0 && 'invisible'
        )}
      />
      <span className="min-w-0 truncate">{worktree.branch}</span>
      {worktree.locked && <LockKeyhole className="text-muted-foreground" />}
      {worktree.missing && <AlertCircle className="text-destructive" />}
      {namingLabel && <span className="shrink-0 text-muted-foreground">{namingLabel}</span>}
    </Button>
  )

  // A failed name is a retryable state, so the row offers the retry next to the other row actions
  // instead of only naming the error; the reason stays one hover away.
  const retryButton = worktree.naming === 'failed' ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-destructive hover:text-destructive !bg-transparent"
          aria-label={t('worktree.retryNamingAria', { branch: worktree.branch })}
          disabled={pending !== null || worktree.missing}
          aria-busy={retrying}
          onClick={() =>
            void runAction(`retry-naming:${worktree.cwd}`, () =>
              api.retryWorktreeNaming(projectCwd, worktree.cwd)
            )
          }
        >
          {retrying ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
        <span>{t('worktree.retryNaming')}</span>
        {worktree.namingError && <span className="break-words">{worktree.namingError}</span>}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="px-1">
        <div
          data-sidebar-hover-row
          className={cn(
            'group/worktree relative flex h-7 min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors',
            active && 'bg-sidebar-accent'
          )}
        >
          {sessions.length > 0 ? (
            <CollapsibleTrigger asChild>{branchButton}</CollapsibleTrigger>
          ) : branchButton}
          {retryButton}
          {!worktree.isPrimary && (
            <WorktreeDeleteButton
              branch={worktree.branch}
              projectCwd={projectCwd}
              cwd={worktree.cwd}
              disabled={pending !== null}
              busy={pending === `delete:${worktree.cwd}`}
              runAction={runAction}
              onConfirm={(force) => deleteWorktree(projectCwd, worktree.cwd, force)}
            />
          )}
          <SessionHistoryPopover
            cwd={worktree.cwd}
            size="icon-xs"
            triggerClassName="pointer-events-none opacity-0 transition-opacity group-hover/worktree:pointer-events-auto group-hover/worktree:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              '!bg-transparent',
              pending !== `new:${worktree.cwd}` &&
                'pointer-events-none opacity-0 transition-opacity group-hover/worktree:pointer-events-auto group-hover/worktree:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
            )}
            aria-label={t('worktree.newSessionAria', { branch: worktree.branch })}
            disabled={pending !== null || worktree.missing}
            aria-busy={pending === `new:${worktree.cwd}`}
            onClick={() =>
              void runAction(`new:${worktree.cwd}`, async () => {
                onOpenChange(true)
                await newSession(worktree.cwd)
              })
            }
          >
            {pending === `new:${worktree.cwd}` ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Plus />
            )}
          </Button>
        </div>
      </div>
      <CollapsibleContent>
        {sessions.length > 0 ? <SessionList sessions={sessions} /> : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
