/**
 * Sidebarless full-window Bot conversation stage:
 * - Minimal h-10 draggable top bar (glass-orb Tasks button + BotOrbButton aligned with Workspace, status, emergency Reset menu)
 * - Floating BotLiveTaskBar (renders only while active tasks exist)
 * - Centered max-w-3xl MessageScroller projecting ONLY user messages, send_message bubbles (+ delivery cards),
 *   mirrored approval prompts, and system fallback cards — never internal thinking or QueuedMessageRow.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileText,
  FolderKanban,
  Layers,
  MoreHorizontal,
  RotateCcw
} from 'lucide-react'
import { BotAvatar } from 'bot-avatars'
import { toast } from 'sonner'
import {
  composePromptText,
  createInlinePastedTextDisplayMetadata,
  formatPastedTextSize,
  isInlinePastedTextAttachments,
  utf8ByteLength
} from '../../../../shared/pasted-text'
import { isFileMentionAt } from '../../../../shared/file-mentions'
import { baseName } from '../../../../shared/paths'
import {
  DEFAULT_BOT_AVATAR,
  isBotTaskActive,
  type BotAttachmentItem,
  type BotAvatarId,
  type BotTask,
  type BotTimelineItem
} from '../../../../shared/bot'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { failureMessage } from '../../lib/ipc-error'
import { markdownToPlainText } from '../../lib/markdown-plain-text'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useSessionsStore } from '../../stores/sessions'
import { useSettingsStore } from '../../stores/settings'
import { ApprovalPrompt, useApprovalPrompt } from '../composer/ApprovalPrompt'
import { botColumn } from '../../chat/layout'
import { SCROLL_END } from '../../chat/scroll-state'
import { FileTypeIcon } from '../files/FileTypeIcon'
import { FileMentionChip, FileMentionContext, FileMentionProvider } from '../FileMentionChip'
import { ImagePreview } from '../ImagePreview'
import { IssueMentionChip, renderTextWithIssueChips } from '../IssueMentionNode'
import { MarkdownText } from '../MarkdownText'
import { PastedTextChip } from '../PastedTextChip'
import { PastedTextPreview } from '../PastedTextPreview'
import { ShortcutKbd } from '../ShortcutKbd'
import { userBubbleSurface } from '../turn/TurnMessages'
import { WaitLine } from '../turn/WaitLine'
import { Bubble, BubbleContent } from '../ui/bubble'
import { Button } from '../ui/button'
import { Message, MessageContent } from '../ui/message'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
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
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller
} from '../ui/message-scroller'
import { BotOrbButton } from './BotOrbButton'
import { KanbanToggleButton } from '../kanban/KanbanToggleButton'
import { BotLiveTaskBar } from './BotLiveTaskBar'
import { BotTaskCard, type BotTaskNavigation } from './BotTaskCard'
import { BotTaskDrawer } from './BotTaskDrawer'
import { BotComposer } from './BotComposer'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
/** Overrides MessageScrollerItem's `content-visibility: auto` (`contain: paint`) so bubble/card shadows and rings are never clipped. */
const unclippedItem = '[content-visibility:visible] [contain-intrinsic-size:none]'

export interface BotWorkspaceJumpOptions {
  cwd: string
  projectCwd?: string
  sessionId?: string
  openChanges?: boolean
  openFilePath?: string
  openFileLine?: number
}

/**
 * Resolves an absolute attachment file path to the most specific active workspace or opened project root
 * so clicking an attachment opens its file tab directly inside Pig's workspace.
 */
export function resolveWorkspaceFileTarget(
  filePath: string,
  preferredCwds: readonly string[],
  projects: readonly { cwd: string; worktrees?: readonly { cwd: string; missing: boolean }[] }[],
  tasks: readonly BotTask[]
): { cwd: string; relativePath: string } | null {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (cwd: string | undefined) => {
    if (!cwd) return
    const trimmed = cwd.replace(/[\\/]+$/, '')
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    candidates.push(trimmed)
  }

  for (const cwd of preferredCwds) push(cwd)
  for (const task of tasks) {
    if (!task.workspace.cleanedUpAt) push(task.workspace.cwd)
    push(task.projectCwd)
  }
  for (const proj of projects) {
    push(proj.cwd)
    for (const wt of proj.worktrees ?? []) {
      if (!wt.missing) push(wt.cwd)
    }
  }

  const normalizedFile = filePath.replace(/\\/g, '/')
  let best: { cwd: string; relativePath: string; rootLen: number } | null = null
  for (const cwd of candidates) {
    const normalizedRoot = cwd.replace(/\\/g, '/')
    const prefix = normalizedRoot === '' ? '/' : `${normalizedRoot}/`
    if (normalizedFile.startsWith(prefix) && normalizedFile.length > prefix.length) {
      if (!best || normalizedRoot.length > best.rootLen) {
        best = {
          cwd,
          relativePath: normalizedFile.slice(prefix.length),
          rootLen: normalizedRoot.length
        }
      }
    }
  }
  return best ? { cwd: best.cwd, relativePath: best.relativePath } : null
}

export function BotPage({
  onJumpToWorkspace,
  onOpenKanban
}: {
  onJumpToWorkspace: (options: BotWorkspaceJumpOptions) => void
  onOpenKanban?: () => void
}) {
  const t = useT()
  const botOpen = useBotStore((s) => s.open)
  const state = useBotStore((s) => s.state)
  const timeline = useBotStore((s) => s.timeline)
  const tasks = useBotStore((s) => s.tasks)
  const streaming = useBotStore((s) => s.streaming)
  const approvals = useBotStore((s) => s.approvals)
  const drawerOpen = useBotStore((s) => s.drawerOpen)
  const closeBot = useBotStore((s) => s.closeBot)
  const toggleDrawer = useBotStore((s) => s.toggleDrawer)
  const setDraftInput = useBotStore((s) => s.setDraftInput)
  const retryLastMessage = useBotStore((s) => s.retryLastMessage)
  const resetContext = useBotStore((s) => s.resetContext)

  const projects = useSessionsStore((s) => s.projects)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const botSessionId = state?.sessionId ?? null
  const avatar = state?.avatar ?? DEFAULT_BOT_AVATAR
  const directApprovalPrompt = useApprovalPrompt(botSessionId)
  const fallbackApprovalSessionId = directApprovalPrompt ? null : (approvals[0]?.sessionId ?? null)
  const fallbackApprovalPrompt = useApprovalPrompt(fallbackApprovalSessionId)
  const activeApprovalPrompt = directApprovalPrompt ?? fallbackApprovalPrompt
  const approvalSessionId = directApprovalPrompt ? botSessionId : fallbackApprovalSessionId

  const activeTaskCount = useMemo(() => tasks.filter((item) => isBotTaskActive(item.status)).length, [tasks])
  const tasksById = useMemo(() => new Map(tasks.map((item) => [item.taskId, item])), [tasks])

  // Show each task's full card only under the latest timeline entry that references it, avoiding duplicate stacked cards.
  const latestCardItemByTaskId = useMemo(() => {
    const owners = new Map<string, string>()
    for (const item of timeline) {
      if (item.kind === 'user' || !item.taskIds?.length) continue
      for (const id of item.taskIds) {
        owners.set(id, item.id)
      }
    }
    return owners
  }, [timeline])

  // Preserve calm inline feedback right at the user's gaze point after answering a mirrored background-task approval,
  // bridging the quiet window while the background task finishes its remaining work before Bot replies.
  const prevApprovalsRef = useRef(approvals)
  const [resumedApproval, setResumedApproval] = useState<{ taskId: string; timelineLen: number } | null>(null)

  useEffect(() => {
    const prev = prevApprovalsRef.current
    prevApprovalsRef.current = approvals
    const currentIds = new Set(approvals.map((a) => a.requestId))
    const resolvedWithTask = prev.find((a) => a.taskId && !currentIds.has(a.requestId))
    if (resolvedWithTask?.taskId) {
      const task = tasksById.get(resolvedWithTask.taskId)
      if (task && isBotTaskActive(task.status)) {
        setResumedApproval({ taskId: task.taskId, timelineLen: timeline.length })
      }
    }
  }, [approvals, tasksById, timeline.length])

  useEffect(() => {
    if (!resumedApproval) return
    const task = tasksById.get(resumedApproval.taskId)
    if (
      activeApprovalPrompt ||
      timeline.length > resumedApproval.timelineLen ||
      !task ||
      !isBotTaskActive(task.status)
    ) {
      setResumedApproval(null)
    }
  }, [resumedApproval, activeApprovalPrompt, timeline.length, tasksById])

  const resumedApprovalTask = resumedApproval ? tasksById.get(resumedApproval.taskId) ?? null : null

  const navigation: BotTaskNavigation = useMemo(
    () => ({
      onOpenSession: (task: BotTask) => {
        const latestRun = [...task.runs].reverse().find((r) => r.sessionId)
        const targetCwd = task.workspace.cleanedUpAt ? task.projectCwd : task.workspace.cwd
        closeBot()
        onJumpToWorkspace({
          cwd: targetCwd,
          projectCwd: task.projectCwd,
          sessionId: latestRun?.sessionId,
          openChanges: false
        })
      },
      onViewChanges: (task: BotTask) => {
        const latestRun = [...task.runs].reverse().find((r) => r.sessionId)
        const targetCwd = task.workspace.cleanedUpAt ? task.projectCwd : task.workspace.cwd
        closeBot()
        onJumpToWorkspace({
          cwd: targetCwd,
          projectCwd: task.projectCwd,
          sessionId: latestRun?.sessionId,
          openChanges: true
        })
      }
    }),
    [closeBot, onJumpToWorkspace]
  )

  const handleOpenAttachmentFile = useCallback(
    (cwd: string, relativePath: string, line?: number | null) => {
      closeBot()
      onJumpToWorkspace({
        cwd,
        openFilePath: relativePath,
        ...(line ? { openFileLine: line } : {})
      })
    },
    [closeBot, onJumpToWorkspace]
  )

  // Esc inside BotPage returns to workspace when no modal/drawer is open and composer is not focused
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (resetDialogOpen || drawerOpen) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"], [role="menu"]')) {
        return
      }
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || (active instanceof HTMLElement && active.isContentEditable)) {
        return
      }
      event.preventDefault()
      closeBot()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resetDialogOpen, drawerOpen, closeBot])

  const handleConfirmReset = useCallback(async () => {
    setResetting(true)
    try {
      await resetContext()
      setResetDialogOpen(false)
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      setResetting(false)
    }
  }, [resetContext])

  const handleExportSession = useCallback(async () => {
    if (exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    try {
      await api.bot.exportSession()
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      exportingRef.current = false
      if (mountedRef.current) setExporting(false)
    }
  }, [])

  const statusLine =
    approvals.length > 0
      ? t('bot.statusApproval', { count: approvals.length })
      : activeTaskCount > 0
        ? t('bot.statusBusy', { count: activeTaskCount })
        : streaming
          ? t('bot.statusThinking')
          : t('bot.statusIdle')

  const mirroredApprovalMeta = useMemo(() => {
    if (!activeApprovalPrompt) return null
    return approvals.find((item) => item.requestId === activeApprovalPrompt.id) ?? null
  }, [activeApprovalPrompt, approvals])

  const emptySuggestions = useMemo(() => {
    const first = projects[0]
    if (first) {
      return [
        t('bot.empty.suggestionCheck', { project: first.name }),
        t('bot.empty.suggestionFix', { project: first.name }),
        t('bot.empty.suggestionChat')
      ]
    }
    return [t('bot.empty.suggestionChat')]
  }, [projects, t])

  const isEmpty = timeline.length === 0 && !streaming && !activeApprovalPrompt
  const tasksButtonLabel = activeTaskCount > 0
    ? `${t('bot.tasksButtonAll')} · ${t('bot.tasksButton', { count: activeTaskCount })}`
    : t('bot.tasksButtonAll')

  return (
    <div
      data-bot-page
      data-bot-overlay
      className="flex h-full min-h-0 flex-1 flex-col"
    >
      {/* Minimal h-10 draggable top bar */}
      <header data-bot-header className="drag relative flex h-10 shrink-0 items-center justify-between pr-3 pl-20">
        {/* Occupy SidebarToggle's exact size-7 slot + gap-1 so BotOrbButton stays pixel-aligned with Workspace */}
        <div className="flex h-full shrink-0 items-center gap-1">
          <div className="flex size-7 shrink-0 items-center justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-bot-tasks-trigger
                  aria-label={tasksButtonLabel}
                  aria-expanded={drawerOpen}
                  onClick={() => toggleDrawer()}
                  className={cn(
                    'no-drag relative flex size-5.5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-glass-orb-background bg-[image:var(--glass-orb-sheen)] text-glass-prompt-foreground shadow-glass-orb outline-none transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring motion-reduce:transition-none solid:bg-background solid:bg-none solid:text-foreground solid:shadow-none solid:ring-1 solid:ring-sidebar-border',
                    drawerOpen && 'text-primary solid:ring-primary/50'
                  )}
                >
                  <Layers className="size-3" aria-hidden="true" />
                  {approvals.length > 0 || activeTaskCount > 0 ? (
                    <span
                      aria-hidden="true"
                      data-bot-tasks-badge={approvals.length > 0 ? 'approval' : 'running'}
                      className={cn(
                        'pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-background',
                        approvals.length > 0 ? 'bg-warning' : 'bg-primary'
                      )}
                    />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                <span>{t('bot.tasksButtonAll')}</span>
                {activeTaskCount > 0 ? (
                  <span className="ml-1.5 text-muted-foreground">· {t('bot.tasksButton', { count: activeTaskCount })}</span>
                ) : null}
                <span className="ml-1.5 inline-flex"><ShortcutKbd action="bot.toggleTasks" /></span>
              </TooltipContent>
            </Tooltip>
          </div>
          <BotOrbButton registerAnchor />
          {onOpenKanban ? (
            <KanbanToggleButton active={false} onClick={onOpenKanban} data-bot-open-kanban />
          ) : null}
        </div>

        <div className="pointer-events-none absolute inset-x-48 flex items-center justify-center">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {statusLine}
          </span>
        </div>

        <div className="no-drag flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-bot-export-session
                disabled={exporting || timeline.length === 0}
                aria-label={t('sessions.export')}
                onClick={() => void handleExportSession()}
                className="text-muted-foreground hover:text-foreground"
              >
                <Download className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              {t('sessions.export')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('bot.actions.resetContext')}
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setResetDialogOpen(true)}>
                <RotateCcw className="size-3.5" />
                {t('bot.actions.resetContext')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Main single-axis content surface matching Workspace glass/solid vibrancy */}
      <div
        data-content-surface
        className="relative m-2 mt-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-glass-content-background bg-(image:--glass-content-sheen) shadow-glass-content ring-1 ring-glass-content-border solid:bg-chat-background solid:bg-none solid:shadow-md solid:ring-0"
      >
        <BotLiveTaskBar onOpenSession={navigation.onOpenSession} />

        {isEmpty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
            <div className="flex w-full max-w-2xl flex-col items-center text-center">
              <div className="mb-3 flex items-center justify-center">
                <BotAvatar type={avatar} size={96} />
              </div>
              <h1 className="text-lg font-semibold text-foreground">{t('bot.empty.greeting')}</h1>
              <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{t('bot.empty.subtitle')}</p>

              <div className="mt-6 w-full">
                <BotComposer autoFocus isActive={botOpen} />
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {emptySuggestions.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setDraftInput(prompt)}
                    className="rounded-full border border-glass-card-border bg-glass-pane-background/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground solid:border-border solid:bg-card"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={SCROLL_END}>
                <BotFollowNewSend timeline={timeline} />
                <MessageScroller className="min-h-0 flex-1 py-2">
                  <MessageScrollerViewport className="[--chat-edge-fade:1rem] mask-[linear-gradient(to_bottom,rgb(0_0_0/0.0),rgb(0_0_0)_var(--chat-edge-fade),rgb(0_0_0)_calc(100%-var(--chat-edge-fade)),rgb(0_0_0/0.0))]">
                    <MessageScrollerContent className={cn(botColumn, 'gap-3 py-(--chat-edge-fade)')}>
                      {timeline.map((item, idx) => (
                        <BotTimelineRow
                          key={item.id}
                          item={item}
                          avatar={avatar}
                          grouped={idx > 0 && timeline[idx - 1].kind === 'assistant' && item.kind === 'assistant'}
                          tasks={tasks}
                          projects={projects}
                          tasksById={tasksById}
                          latestCardItemByTaskId={latestCardItemByTaskId}
                          navigation={navigation}
                          onOpenAttachmentFile={handleOpenAttachmentFile}
                          onRetry={() => void retryLastMessage()}
                        />
                      ))}

                      {(streaming || (!activeApprovalPrompt && resumedApprovalTask)) ? (
                        <MessageScrollerItem
                          messageId="bot-working-hint"
                          data-bot-post-approval-hint={!streaming ? resumedApprovalTask?.taskId : undefined}
                          className={cn(unclippedItem, 'flex items-center gap-2 py-1')}
                        >
                          <BotAvatar type={avatar} size={24} state="working" interactive={false} className="shrink-0" />
                          <span className="text-xs text-muted-foreground motion-safe:animate-pulse">
                            {streaming ? <WaitLine streaming /> : t('bot.statusApprovalContinuing', { title: resumedApprovalTask!.title })}
                          </span>
                        </MessageScrollerItem>
                      ) : null}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton behavior="smooth" />
                </MessageScroller>
              </MessageScrollerProvider>
            </div>

            <div className={cn(botColumn, 'shrink-0 pb-3.5')}>
              {activeApprovalPrompt && approvalSessionId ? (
                <div className="mb-2">
                  {mirroredApprovalMeta?.taskTitle ? (
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-warning">
                      <span className="size-1.5 rounded-full bg-warning" />
                      <span>
                        {t('bot.approvalSource', {
                          project: mirroredApprovalMeta.projectName ?? '',
                          title: mirroredApprovalMeta.taskTitle
                        })}
                      </span>
                    </div>
                  ) : null}
                  <ApprovalPrompt sessionId={approvalSessionId} />
                </div>
              ) : (
                <BotComposer autoFocus isActive={botOpen} />
              )}
            </div>
          </>
        )}

        <BotTaskDrawer navigation={navigation} />
      </div>

      {/* Emergency "Start fresh" confirmation dialog (cancel is ghost; destructive never auto-focused) */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bot.actions.resetContextTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('bot.actions.resetContextDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost" disabled={resetting}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction disabled={resetting} onClick={() => void handleConfirmReset()}>
              {t('bot.actions.resetContextConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function BotFollowNewSend({ timeline }: { timeline: BotTimelineItem[] }) {
  const scroller = useMessageScroller()
  const lastUserId = timeline.findLast((item) => item.kind === 'user')?.id
  const previousUserId = useRef(lastUserId)
  useLayoutEffect(() => {
    if (lastUserId && lastUserId !== previousUserId.current) scroller.scrollToEnd()
    previousUserId.current = lastUserId
  }, [lastUserId, scroller])
  return null
}

function BotTimelineRow({
  item,
  avatar,
  grouped,
  tasks,
  projects,
  tasksById,
  latestCardItemByTaskId,
  navigation,
  onOpenAttachmentFile,
  onRetry
}: {
  item: BotTimelineItem
  avatar: BotAvatarId
  grouped: boolean
  tasks: readonly BotTask[]
  projects: readonly { cwd: string; worktrees?: readonly { cwd: string; missing: boolean }[] }[]
  tasksById: Map<string, BotTask>
  latestCardItemByTaskId: Map<string, string>
  navigation: BotTaskNavigation
  onOpenAttachmentFile: (cwd: string, relativePath: string, line?: number | null) => void
  onRetry: () => void
}) {
  const t = useT()

  if (item.kind === 'user') {
    return <BotUserRow item={item} onOpenAttachmentFile={onOpenAttachmentFile} />
  }

  if (item.kind === 'system_fallback') {
    const label =
      item.reason === 'delivery_fallback'
        ? t('bot.fallback.deliveryLabel')
        : t('bot.fallback.noMessageLabel')
    const relatedTasks = [...new Set(item.taskIds ?? [])]
      .filter((id) => latestCardItemByTaskId.get(id) === item.id)
      .map((id) => tasksById.get(id))
      .filter((task): task is BotTask => task !== undefined)
    const fallbackPreferredCwds = relatedTasks.flatMap((task) =>
      task.workspace.cleanedUpAt ? [task.projectCwd] : [task.workspace.cwd, task.projectCwd]
    )

    return (
      <MessageScrollerItem messageId={item.id} className={cn(unclippedItem, 'flex justify-center')}>
        <div
          data-bot-fallback-card={item.reason}
          className="w-full max-w-2xl rounded-xl border border-warning/40 bg-warning-background/40 px-3.5 py-2.5 text-xs text-foreground"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="size-3.5 shrink-0 text-warning" />
            <span className="font-medium text-warning">{label}</span>
            {item.retryable ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onRetry}
                className="ml-auto h-6 px-2 text-xs"
              >
                {t('bot.actions.retry')}
              </Button>
            ) : null}
          </div>
          <div className="mt-1.5 text-foreground/90">
            <FileMentionProvider
              value={{
                cwd: fallbackPreferredCwds[0] ?? null,
                sessionId: null,
                preferredCwds: fallbackPreferredCwds,
                onOpenWorkspaceFile: onOpenAttachmentFile
              }}
            >
              <MarkdownText text={item.text} />
            </FileMentionProvider>
          </div>
          {relatedTasks.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {relatedTasks.map((task) => (
                <BotTaskCard key={task.taskId} task={task} compact navigation={navigation} />
              ))}
            </div>
          ) : null}
        </div>
      </MessageScrollerItem>
    )
  }

  // item.kind === 'assistant' (strictly produced by send_message)
  const referencedTasks = [...new Set(item.taskIds ?? [])]
    .map((id) => tasksById.get(id))
    .filter((task): task is BotTask => task !== undefined)
  const linkedTasks = referencedTasks.filter((task) => latestCardItemByTaskId.get(task.taskId) === item.id)
  const preferredCwds = referencedTasks.flatMap((task) =>
    task.workspace.cleanedUpAt ? [task.projectCwd] : [task.workspace.cwd, task.projectCwd]
  )
  const singleTaskSessionId =
    referencedTasks.length === 1
      ? ([...referencedTasks[0].runs].reverse().find((run) => run.sessionId)?.sessionId ?? null)
      : null

  return (
    <MessageScrollerItem
      messageId={item.id}
      className={cn(unclippedItem, 'group/bot-reply flex flex-col items-start gap-1.5', grouped ? '-mt-2' : '')}
    >
      {!grouped ? (
        <div data-bot-assistant-header className="flex items-center">
          <BotAvatar type={avatar} size={24} paused interactive={false} />
        </div>
      ) : null}

      <div data-bot-assistant-bubble className="w-full min-w-0 space-y-2">
        <div data-bot-assistant-body className="text-sm leading-relaxed text-foreground">
          <FileMentionProvider
            value={{
              cwd: preferredCwds[0] ?? null,
              sessionId: singleTaskSessionId,
              preferredCwds,
              onOpenWorkspaceFile: onOpenAttachmentFile
            }}
          >
            <MarkdownText text={item.content} />
          </FileMentionProvider>
        </div>

        {item.attachments?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {item.attachments.map((att) => (
              <BotAttachmentChip
                key={att.path}
                attachment={att}
                target={resolveWorkspaceFileTarget(att.path, preferredCwds, projects, tasks)}
                onOpenFile={onOpenAttachmentFile}
              />
            ))}
          </div>
        ) : null}

        {linkedTasks.length > 0 ? (
          <div className="flex flex-col gap-2">
            {linkedTasks.map((task) => (
              <BotTaskCard key={task.taskId} task={task} compact navigation={navigation} />
            ))}
          </div>
        ) : null}

        <BotMessageActions align="start" text={item.content} timestamp={item.createdAt} />
      </div>
    </MessageScrollerItem>
  )
}

function BotAttachmentChip({
  attachment,
  target,
  onOpenFile
}: {
  attachment: BotAttachmentItem
  target: { cwd: string; relativePath: string } | null
  onOpenFile: (cwd: string, relativePath: string) => void
}) {
  const t = useT()
  const { copied, copy } = useCopyFeedback(attachment.path)
  const missing = !attachment.exists
  const tooltipText = missing
    ? `${t('fileMention.missing')} · ${attachment.path}`
    : target
      ? `${t('turnChanges.openFile')} · ${attachment.path}`
      : copied
        ? t('common.copied')
        : `${t('fileMention.copyPath')} · ${attachment.path}`

  const handleClick = async () => {
    if (missing) return
    if (target) {
      onOpenFile(target.cwd, target.relativePath)
      return
    }
    try {
      await copy(attachment.path)
    } catch (error) {
      toast.error(t('turn.messageActionFailed'), { description: failureMessage(error) })
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          data-bot-attachment={attachment.path}
          aria-disabled={missing || undefined}
          aria-label={attachment.name}
          onClick={() => void handleClick()}
          className="h-6 max-w-72 gap-1.5 rounded-lg px-2 text-xs font-normal aria-disabled:cursor-default aria-disabled:opacity-60"
        >
          {copied ? (
            <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <FileTypeIcon path={attachment.name} className="size-3.5 shrink-0" />
          )}
          <span className={cn('min-w-0 truncate font-medium', missing && 'text-muted-foreground line-through')}>
            {attachment.name}
          </span>
          {attachment.size !== undefined ? (
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
              {formatPastedTextSize(attachment.size)}
            </span>
          ) : null}
          {!missing && target ? (
            <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-md break-all">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  )
}

function BotMessageActions({
  text,
  timestamp,
  align
}: {
  text: string
  timestamp: number
  align: 'start' | 'end'
}) {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const timestampFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }),
    [locale]
  )
  const fullTimestamp = timestampFormat.format(timestamp)
  const { copied, copy } = useCopyFeedback(text)
  const [menuOpen, setMenuOpen] = useState(false)

  async function copyContent(format: 'markdown' | 'plain' = 'markdown'): Promise<void> {
    try {
      await copy(format === 'plain' ? markdownToPlainText(text) : text)
    } catch (error) {
      toast.error(t('turn.messageActionFailed'), { description: failureMessage(error) })
    }
  }

  const timeNode = (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={new Date(timestamp).toISOString()}
          tabIndex={0}
          aria-label={fullTimestamp}
          className={cn(
            'rounded-sm text-xs tabular-nums outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring',
            align === 'start' ? 'ml-1.5' : 'mr-1.5'
          )}
        >
          {clock.format(timestamp)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-none whitespace-nowrap">
        {fullTimestamp}
      </TooltipContent>
    </Tooltip>
  )

  return (
    <div
      data-bot-message-actions={align}
      className={cn(
        '-mt-1 flex h-6 items-center gap-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
        align === 'end'
          ? 'justify-end group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100'
          : 'justify-start group-hover/bot-reply:opacity-100 group-focus-within/bot-reply:opacity-100',
        (menuOpen || copied) && 'opacity-100'
      )}
    >
      {align === 'end' ? timeNode : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-bot-copy-button
            aria-label={t(copied ? 'common.copied' : 'common.copy')}
            disabled={!text}
            onClick={() => void copyContent()}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t(copied ? 'common.copied' : 'common.copy')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t('turn.moreActions')}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>{t('turn.moreActions')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align={align} side="bottom">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!text} onSelect={() => void copyContent('markdown')}>
              <Copy />
              {t('turn.copyMarkdown')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!text} onSelect={() => void copyContent('plain')}>
              <Copy />
              {t('turn.copyPlainText')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {align === 'start' ? timeNode : null}
    </div>
  )
}

function BotUserRow({
  item,
  onOpenAttachmentFile
}: {
  item: Extract<BotTimelineItem, { kind: 'user' }>
  onOpenAttachmentFile?: (cwd: string, relativePath: string, line?: number | null) => void
}) {
  const t = useT()
  const [preview, setPreview] = useState<string | null>(null)
  const images = (item.images ?? []).flatMap((image, i) => {
    const src = image.data && image.mimeType ? `data:${image.mimeType};base64,${image.data}` : null
    return src ? [{ key: i, src }] : []
  })
  const normalizedAttachments = (item.textAttachments ?? []).map((attachment) => ({
    ...attachment,
    byteSize: attachment.byteSize ?? utf8ByteLength(attachment.text)
  }))
  const inlineAttachments =
    normalizedAttachments.length > 0 && isInlinePastedTextAttachments(item.text, normalizedAttachments)
      ? normalizedAttachments
      : undefined
  const fileMentions = (item.fileMentions ?? []).filter((mention) => isFileMentionAt(item.text, mention))
  const hasInlineSegments = Boolean(inlineAttachments || fileMentions.length > 0)
  const inlineSegments = hasInlineSegments
    ? createInlinePastedTextDisplayMetadata(item.text, inlineAttachments ?? [], fileMentions).segments
    : undefined
  const legacyAttachments = hasInlineSegments ? [] : normalizedAttachments
  const projectMentions = item.projectMentions ?? []
  const issueMentions = item.issueMentions ?? []
  const mentionContext = useMemo(
    () => ({
      cwd: projectMentions[0] ?? null,
      sessionId: null,
      preferredCwds: projectMentions,
      onOpenWorkspaceFile: onOpenAttachmentFile
    }),
    [projectMentions, onOpenAttachmentFile]
  )
  const hasTextBubble =
    projectMentions.length > 0 ||
    issueMentions.length > 0 ||
    Boolean(inlineSegments?.length) ||
    legacyAttachments.length > 0 ||
    item.text.length > 0
  const copyText = legacyAttachments.length > 0 ? composePromptText(item.text, legacyAttachments) : item.text

  return (
    <MessageScrollerItem messageId={item.id} className={unclippedItem}>
      <Message align="end" className="group/user-message">
        <MessageContent className="w-fit max-w-9/10 gap-1.5">
          {images.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              {images.map(({ key, src }) => (
                <Button
                  key={key}
                  type="button"
                  variant="ghost"
                  className="block h-auto rounded-md p-0 hover:bg-transparent"
                  aria-label={t('composer.previewImage')}
                  onClick={() => setPreview(src)}
                >
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-10 max-w-16 cursor-pointer rounded-md object-cover"
                  />
                </Button>
              ))}
            </div>
          ) : null}
          {hasTextBubble ? (
            <Bubble align="end" data-bot-user-bubble className={userBubbleSurface}>
              <BubbleContent
                className={cn(
                  'flex max-w-full flex-col gap-1.5',
                  (Boolean(inlineSegments) || legacyAttachments.length > 0) && 'border-border'
                )}
              >
                {projectMentions.length > 0 || issueMentions.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {projectMentions.map((cwd) => (
                      <span
                        key={`proj:${cwd}`}
                        className="inline-flex h-5 max-w-60 items-center gap-1 rounded-md border border-glass-button-border bg-glass-button-background bg-[image:var(--glass-button-sheen)] px-1.5 text-xs font-medium text-glass-prompt-foreground shadow-glass-button solid:border-transparent solid:bg-secondary solid:bg-none solid:text-secondary-foreground solid:shadow-none"
                      >
                        <FolderKanban className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 truncate">@{baseName(cwd)}</span>
                      </span>
                    ))}
                    {issueMentions.map((num) => (
                      <IssueMentionChip key={`issue:${num}`} number={num} className="h-5 max-w-60" />
                    ))}
                  </div>
                ) : null}
                {inlineSegments ? (
                  <FileMentionContext.Provider value={mentionContext}>
                    <div className="whitespace-pre-wrap break-words">
                      {inlineSegments.map((segment, index) =>
                        segment.type === 'text' ? (
                          <span key={index}>{renderTextWithIssueChips(segment.text)}</span>
                        ) : segment.type === 'file' ? (
                          <FileMentionChip key={index} path={segment.path} opensFile />
                        ) : segment.type === 'attachment' ? (
                          <PastedTextChip key={segment.attachment.id} attachment={segment.attachment} />
                        ) : (
                          <span key={index}>{segment.text}</span>
                        )
                      )}
                    </div>
                  </FileMentionContext.Provider>
                ) : (
                  <>
                    {legacyAttachments.map((attachment) => (
                      <PastedTextPreview
                        key={attachment.id}
                        text={attachment.text}
                        byteSize={attachment.byteSize}
                        title={attachment.filename}
                      >
                        <Button
                          type="button"
                          variant="outline"
                          className="h-auto w-full min-w-0 max-w-full justify-start gap-2 rounded-lg px-2.5 py-2 text-left font-normal whitespace-normal"
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-xs font-medium">
                              <FileText data-icon="inline-start" />
                              <span>{attachment.filename ?? t('composer.pastedText')}</span>
                            </span>
                            <span className="line-clamp-3 max-h-15 block overflow-hidden whitespace-pre-wrap break-words text-xs text-muted-foreground">
                              {attachment.text}
                            </span>
                            <span className="mt-1 block text-[10px] text-muted-foreground">
                              UTF-8 {formatPastedTextSize(attachment.byteSize)}
                            </span>
                          </span>
                        </Button>
                      </PastedTextPreview>
                    ))}
                    {item.text ? (
                      <div className="whitespace-pre-wrap break-words">{renderTextWithIssueChips(item.text)}</div>
                    ) : null}
                  </>
                )}
              </BubbleContent>
            </Bubble>
          ) : null}
          <BotMessageActions align="end" text={copyText} timestamp={item.createdAt} />
          <ImagePreview src={preview} onClose={() => setPreview(null)} />
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  )
}
