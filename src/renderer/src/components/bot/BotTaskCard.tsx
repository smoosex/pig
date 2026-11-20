/**
 * Structured task card shared between Bot delivery messages and the Bot task drawer.
 * Displays status, project/branch provenance, proportional diff counts, and safe actions
 * (jump to session, view changes, stop, take over, follow-up, and guarded worktree cleanup).
 */
import { useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  FileDiff,
  GitBranch,
  Hand,
  LoaderCircle,
  PauseCircle,
  Play,
  Square,
  Trash2,
  XCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { baseName } from '../../../../shared/paths'
import { isBotTaskActive, type BotTask, type BotWorktreeCleanupSafety } from '../../../../shared/bot'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { FileChangeCounts } from '../turn/TurnFileChanges'
import { SessionRunningOrb } from '../RunningSpinners'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'

export interface BotTaskNavigation {
  onOpenSession: (task: BotTask) => void
  onViewChanges: (task: BotTask) => void
}

function StatusIcon({ status }: { status: BotTask['status'] }) {
  switch (status) {
    case 'blocked_approval':
      return <AlertTriangle className="size-3.5 shrink-0 text-warning" />
    case 'starting':
      return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
    case 'running':
      return <SessionRunningOrb className="size-3.5 shrink-0" />
    case 'completed':
      return <CheckCircle2 className="size-3.5 shrink-0 text-success" />
    case 'failed':
      return <XCircle className="size-3.5 shrink-0 text-destructive" />
    case 'stopped':
    case 'interrupted':
      return <PauseCircle className="size-3.5 shrink-0 text-muted-foreground" />
    case 'taken_over':
      return <Hand className="size-3.5 shrink-0 text-primary" />
  }
}

export function BotTaskCard({
  task,
  compact = false,
  highlighted = false,
  navigation
}: {
  task: BotTask
  compact?: boolean
  highlighted?: boolean
  navigation: BotTaskNavigation
}) {
  const t = useT()
  const stopping = useBotStore((s) => Boolean(s.stoppingTaskIds[task.taskId]))
  const stopTask = useBotStore((s) => s.stopTask)
  const takeOverTask = useBotStore((s) => s.takeOverTask)
  const followupTask = useBotStore((s) => s.followupTask)
  const cleanupWorktree = useBotStore((s) => s.cleanupWorktree)

  const [followupOpen, setFollowupOpen] = useState(false)
  const [followupText, setFollowupText] = useState('')
  const [submittingFollowup, setSubmittingFollowup] = useState(false)
  const [cleanupSafety, setCleanupSafety] = useState<BotWorktreeCleanupSafety | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const active = isBotTaskActive(task.status)
  const latestRun = task.runs.at(-1)
  const hasSession = Boolean(latestRun?.sessionId)
  const worktreeActive = task.workspace.kind === 'worktree' && !task.workspace.cleanedUpAt
  const canFollowup =
    (task.status === 'failed' || task.status === 'stopped' || task.status === 'interrupted') &&
    (task.workspace.kind !== 'worktree' || !task.workspace.cleanedUpAt)
  const canCleanup = !active && worktreeActive
  const projectName = baseName(task.projectCwd)
  const receipt = task.latestReceipt
  const hasWritableChanges = task.mode === 'write' && Boolean(receipt?.changedFiles.length)
  const statusLabel =
    task.status === 'stopped' && latestRun?.stopOrigin === 'user'
      ? t('bot.taskStatus.stoppedByUser')
      : t(`bot.taskStatus.${task.status}` as Parameters<typeof t>[0])

  const handleStop = async () => {
    try {
      await stopTask(task.taskId)
    } catch (error) {
      toast.error(failureMessage(error))
    }
  }

  const handleTakeOver = async () => {
    try {
      const updated = await takeOverTask(task.taskId)
      navigation.onOpenSession(updated)
    } catch (error) {
      toast.error(failureMessage(error))
    }
  }

  const handleFollowupSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = followupText.trim()
    if (!trimmed || submittingFollowup) return
    setSubmittingFollowup(true)
    try {
      await followupTask(task.taskId, trimmed)
      setFollowupText('')
      setFollowupOpen(false)
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      setSubmittingFollowup(false)
    }
  }

  const handleCleanupClick = async () => {
    setCleaning(true)
    try {
      const safety = await api.bot.checkWorktreeCleanup(task.taskId)
      if (safety.needsForceConfirm) {
        setCleanupSafety(safety)
      } else {
        await cleanupWorktree(task.taskId)
      }
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      setCleaning(false)
    }
  }

  const confirmDirtyCleanup = async () => {
    if (!cleanupSafety) return
    setCleaning(true)
    setCleanupSafety(null)
    try {
      await cleanupWorktree(task.taskId, cleanupSafety.snapshot)
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      setCleaning(false)
    }
  }

  return (
    <>
      <div
        data-bot-task-card={task.taskId}
        className={cn(
          'rounded-xl border border-glass-card-border bg-glass-pane-background/70 px-3 py-2.5 text-xs transition-colors',
          'solid:border-border solid:bg-card',
          highlighted && 'ring-2 ring-primary/50'
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusIcon status={task.status} />
          <span className="shrink-0 font-medium text-foreground">
            {statusLabel}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate font-medium text-foreground/90">{projectName}</span>
          {task.workspace.branch ? (
            <span className="ml-auto inline-flex max-w-44 shrink-0 items-center gap-1 truncate rounded-md bg-foreground/6 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{task.workspace.branch}</span>
            </span>
          ) : null}
        </div>

        <p className={cn('mt-1 text-foreground/90 break-words', compact ? 'line-clamp-1 font-medium' : 'font-medium')}>
          {task.title}
        </p>

        {!compact && task.summary && task.summary !== task.title ? (
          <p className="mt-0.5 line-clamp-2 text-muted-foreground break-words">{task.summary}</p>
        ) : null}

        {receipt && (hasWritableChanges || receipt.errorMessage) ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {hasWritableChanges ? (
              <>
                <span>{t('bot.filesSummary', { count: receipt.changedFiles.length })}</span>
                <FileChangeCounts
                  indicator
                  file={{
                    added: receipt.totalAdded,
                    removed: receipt.totalRemoved,
                    unknownOperations: 0
                  }}
                />
              </>
            ) : null}
            {receipt.errorMessage ? (
              <span className="truncate text-destructive">{receipt.errorMessage}</span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {hasSession ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => navigation.onOpenSession(task)}
            >
              <ArrowUpRight className="size-3" />
              {t('bot.actions.openSession')}
            </Button>
          ) : null}
          {worktreeActive || hasWritableChanges ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => navigation.onViewChanges(task)}
            >
              <FileDiff className="size-3" />
              {t('bot.actions.viewChanges')}
            </Button>
          ) : null}
          {active ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={stopping}
                onClick={() => void handleStop()}
              >
                {stopping ? <LoaderCircle className="size-3 animate-spin" /> : <Square className="size-3" />}
                {stopping ? t('bot.actions.stopping') : t('bot.actions.stop')}
              </Button>
              {hasSession ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={stopping}
                  onClick={() => void handleTakeOver()}
                >
                  <Hand className="size-3" />
                  {t('bot.actions.takeOver')}
                </Button>
              ) : null}
            </>
          ) : null}
          {canFollowup ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => setFollowupOpen((v) => !v)}
            >
              <Play className="size-3" />
              {t('bot.actions.continue')}
            </Button>
          ) : null}
          {canCleanup ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={cleaning}
              onClick={() => void handleCleanupClick()}
              className="ml-auto text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-3" />
              {t('bot.actions.cleanupWorktree')}
            </Button>
          ) : null}
        </div>

        {followupOpen ? (
          <form onSubmit={(e) => void handleFollowupSubmit(e)} className="mt-2 flex items-center gap-1.5">
            <Input
              value={followupText}
              onChange={(e) => setFollowupText(e.target.value)}
              placeholder={t('bot.followupPlaceholder')}
              className="h-7 text-xs"
              autoFocus
            />
            <Button type="submit" size="xs" disabled={!followupText.trim() || submittingFollowup}>
              {t('bot.followupSubmit')}
            </Button>
          </form>
        ) : null}
      </div>

      <AlertDialog open={cleanupSafety !== null} onOpenChange={(next) => { if (!next) setCleanupSafety(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bot.actions.cleanupDirtyTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('bot.actions.cleanupDirtyDescription', { branch: cleanupSafety?.branch ?? task.workspace.branch ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDirtyCleanup()}>
              {t('bot.actions.cleanupConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
