/**
 * Slim top banner shown inside ChatView when viewing a worktree session currently managed by Bot.
 * Offers quick return to Bot, exact user stop (reporting back to Bot), and stop-and-takeover.
 */
import { useMemo } from 'react'
import { ArrowLeft, GitBranch, Hand, LoaderCircle, Square } from 'lucide-react'
import { toast } from 'sonner'
import { isBotTaskActive } from '../../../../shared/bot'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { useBotStore } from '../../stores/bot'
import { Button } from '../ui/button'

export function BotManagedBanner({ sessionId }: { sessionId: string }) {
  const t = useT()
  const tasks = useBotStore((s) => s.tasks)
  const stoppingTaskIds = useBotStore((s) => s.stoppingTaskIds)
  const openBot = useBotStore((s) => s.openBot)
  const stopTask = useBotStore((s) => s.stopTask)
  const takeOverTask = useBotStore((s) => s.takeOverTask)

  const managedTask = useMemo(() => {
    for (const task of tasks) {
      if (!isBotTaskActive(task.status)) continue
      const activeRun = task.runs.find((r) => r.runId === task.activeRunId) ?? task.runs.at(-1)
      if (activeRun?.sessionId === sessionId) return task
    }
    return null
  }, [tasks, sessionId])

  if (!managedTask) return null

  const stopping = Boolean(stoppingTaskIds[managedTask.taskId])

  const handleStop = async () => {
    try {
      await stopTask(managedTask.taskId)
    } catch (error) {
      toast.error(failureMessage(error))
    }
  }

  const handleTakeOver = async () => {
    try {
      await takeOverTask(managedTask.taskId)
    } catch (error) {
      toast.error(failureMessage(error))
    }
  }

  return (
    <div
      data-bot-managed-banner={managedTask.taskId}
      className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-primary/8 px-3 py-1.5 text-xs text-foreground"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="font-medium">{t('bot.managedBanner.label')}</span>
      {managedTask.workspace.branch ? (
        <span className="inline-flex min-w-0 items-center gap-1 truncate rounded-md bg-foreground/6 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{managedTask.workspace.branch}</span>
        </span>
      ) : null}
      <div className="flex-1" />
      <Button type="button" variant="ghost" size="xs" onClick={() => openBot()}>
        <ArrowLeft className="size-3" />
        {t('bot.managedBanner.returnToBot')}
      </Button>
      <Button type="button" variant="ghost" size="xs" disabled={stopping} onClick={() => void handleStop()}>
        {stopping ? <LoaderCircle className="size-3 animate-spin" /> : <Square className="size-3" />}
        {stopping ? t('bot.actions.stopping') : t('bot.managedBanner.stop')}
      </Button>
      <Button type="button" variant="secondary" size="xs" disabled={stopping} onClick={() => void handleTakeOver()}>
        <Hand className="size-3" />
        {t('bot.managedBanner.takeOver')}
      </Button>
    </div>
  )
}
