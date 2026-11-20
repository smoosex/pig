/**
 * Single-row floating live task strip pinned under the BotPage top bar.
 * Only renders when active tasks exist; prioritizes blocked_approval > starting > running
 * and folds excess tasks into a +M capsule after 3 total slots.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, LoaderCircle, Square } from 'lucide-react'
import { toast } from 'sonner'
import { baseName } from '../../../../shared/paths'
import type { BotTask } from '../../../../shared/bot'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn } from '../../lib/utils'
import { sortLiveBotTasks, useBotStore } from '../../stores/bot'
import { SessionRunningOrb } from '../RunningSpinners'

function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function BotLiveTaskBar({
  onOpenSession
}: {
  onOpenSession: (task: BotTask) => void
}) {
  const t = useT()
  const tasks = useBotStore((s) => s.tasks)
  const stoppingTaskIds = useBotStore((s) => s.stoppingTaskIds)
  const stopTask = useBotStore((s) => s.stopTask)
  const setDrawerOpen = useBotStore((s) => s.setDrawerOpen)

  const liveTasks = useMemo(() => sortLiveBotTasks(tasks), [tasks])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (liveTasks.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [liveTasks.length])

  if (liveTasks.length === 0) return null

  const hasOverflow = liveTasks.length > 3
  const visible = hasOverflow ? liveTasks.slice(0, 2) : liveTasks
  const overflowCount = liveTasks.length - visible.length

  const handleStop = async (taskId: string) => {
    try {
      await stopTask(taskId)
    } catch (error) {
      toast.error(failureMessage(error))
    }
  }

  return (
    <div
      data-bot-live-task-bar
      className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 overflow-hidden px-4 pt-2 pb-1"
    >
      {visible.map((task) => {
        const stopping = Boolean(stoppingTaskIds[task.taskId])
        const latestRun = task.runs.at(-1)
        const sessionReady = Boolean(latestRun?.sessionId)
        const projectName = baseName(task.projectCwd)
        const timing =
          stopping ? t('bot.actions.stopping')
            : task.status === 'starting' ? t('bot.taskStatus.starting')
              : task.status === 'blocked_approval' ? t('bot.taskStatus.blocked_approval')
                : formatElapsed(latestRun?.startedAt ?? task.createdAt, now)

        return (
          <div
            key={task.taskId}
            data-live-task-capsule={task.taskId}
            className={cn(
              'group relative flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
              'border-glass-card-border bg-glass-pane-background/75 solid:border-border solid:bg-card/90',
              task.status === 'blocked_approval' && 'border-warning/60 bg-warning-background/40 solid:border-warning/70'
            )}
          >
            <button
              type="button"
              onClick={() => setDrawerOpen(true, task.taskId)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
            >
              {stopping ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : task.status === 'blocked_approval' ? (
                <span className="size-2 shrink-0 rounded-full bg-warning" />
              ) : task.status === 'starting' ? (
                <span className="size-2 shrink-0 rounded-full bg-primary animate-pulse" />
              ) : (
                <SessionRunningOrb className="size-3.5 shrink-0" />
              )}
              <span className="truncate font-medium text-foreground">
                {projectName} · {task.title}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                {timing}
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5 opacity-75 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                disabled={!sessionReady}
                aria-label={t('bot.actions.openSession')}
                title={t('bot.actions.openSession')}
                onClick={(e) => {
                  e.stopPropagation()
                  if (sessionReady) onOpenSession(task)
                }}
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-35"
              >
                <ArrowUpRight className="size-3" />
              </button>
              <button
                type="button"
                disabled={stopping}
                aria-label={t('bot.actions.stop')}
                title={t('bot.actions.stop')}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleStop(task.taskId)
                }}
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-35"
              >
                <Square className="size-2.5" />
              </button>
            </div>
          </div>
        )
      })}

      {hasOverflow ? (
        <button
          type="button"
          data-live-task-overflow
          onClick={() => setDrawerOpen(true, null)}
          className="inline-flex h-8 shrink-0 items-center rounded-full border border-glass-card-border bg-glass-pane-background/75 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent solid:border-border solid:bg-card"
        >
          {t('bot.tasksMoreCount', { count: overflowCount })}
        </button>
      ) : null}
    </div>
  )
}
