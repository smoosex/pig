import { AlertCircle, ChevronRight, LoaderCircle, LockKeyhole, Plus } from 'lucide-react'
import { useSessionsStore, type WorktreeGroup } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { WorktreeDeleteButton } from './WorktreeActions'
import { SessionList } from './SessionList'
import type { RunProjectAction } from './project-action'

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
  const deleteSession = useSessionsStore((s) => s.deleteSession)
  const openExisting = useSessionsStore((s) => s.openExisting)
  const active = useSessionsStore((s) => {
    const tab = s.openTabs.find((item) => item.sessionId === s.activeSessionId)
    return tab?.cwd === worktree.cwd
  })
  const namingLabel =
    worktree.naming === 'pending'
      ? '待命名'
      : worktree.naming === 'naming'
        ? '命名中'
        : worktree.naming === 'failed'
          ? '命名失败'
          : null

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="px-1">
        <div
          className={cn(
            'group/worktree flex h-7 min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-sidebar-accent',
            active && 'bg-sidebar-accent'
          )}
        >
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="h-full min-w-0 flex-1 justify-start gap-1 rounded-md px-0 text-xs font-normal !bg-transparent"
              aria-label={`${worktree.branch}${namingLabel ? `，${namingLabel}` : ''}`}
            >
              <ChevronRight
                className={cn(
                  'size-2.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100',
                  open && 'rotate-90'
                )}
              />
              <span className="min-w-0 truncate">{worktree.branch}</span>
              {worktree.locked && <LockKeyhole className="text-muted-foreground" />}
              {worktree.missing && <AlertCircle className="text-destructive" />}
              {namingLabel && (
                <span
                  className={cn(
                    'shrink-0 text-muted-foreground',
                    worktree.naming === 'failed' && 'text-destructive'
                  )}
                >
                  {namingLabel}
                </span>
              )}
            </Button>
          </CollapsibleTrigger>
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
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              '!bg-transparent',
              pending !== `new:${worktree.cwd}` &&
                'pointer-events-none opacity-0 transition-opacity group-hover/worktree:pointer-events-auto group-hover/worktree:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
            )}
            aria-label={`在 ${worktree.branch} 中新建会话`}
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
        <SessionList
          sessions={worktree.sessions}
          pending={pending !== null}
          onOpen={(session) => void runAction(`open:${session.id}`, () => openExisting(session))}
          onDelete={(session) =>
            void runAction(`delete-session:${session.id}`, () => deleteSession(session))
          }
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
