/**
 * Dedicated Bot input surface:
 * - Immediate send-and-clear with zero QueuedMessageRow bar
 * - Strict IME composition guard (Enter never sends during composition)
 * - Dual-group `@` mention picker for opened projects AND Kanban issues (prioritizing issues of mentioned projects)
 * - Independent Bot model/thinking picker + low-key permission mode switcher (defaults to full-access)
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUp, AtSign, Eye, FolderKanban, ShieldCheck, ShieldOff, X, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { ThinkingLevel } from '../../../../shared/api'
import type { KanbanIssue } from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { PERMISSION_MODES, type PermissionMode } from '../../../../shared/permissions'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useKanbanStore } from '../../stores/kanban'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useSessionsStore } from '../../stores/sessions'
import { issueMentionLabel, issueMentionMatches } from '../composer/issue-mentions'
import { KanbanStatusIcon } from '../kanban/kanban-icons'
import { InputGroupButton, InputGroupTextarea } from '../ui/input-group'
import { ComposerControls, ComposerSurface, composerTextLayout } from '../composer/ComposerSurface'
import { Button } from '../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { ModelPicker, ThinkingPicker } from '../composer/ModelControls'

const EMPTY_LEVELS: ThinkingLevel[] = ['off']

const MODE_ICONS: Record<PermissionMode, LucideIcon> = {
  'read-only': Eye,
  default: ShieldCheck,
  'full-access': ShieldOff
}

type BotMentionChoice =
  | { kind: 'project'; cwd: string; name: string }
  | { kind: 'issue'; issue: KanbanIssue; detail: string }

export function BotComposer({
  autoFocus = false,
  className
}: {
  autoFocus?: boolean
  className?: string
}) {
  const t = useT()
  const draft = useBotStore((s) => s.draftInput)
  const setDraft = useBotStore((s) => s.setDraftInput)
  const projectMentions = useBotStore((s) => s.draftProjectMentions)
  const setProjectMentions = useBotStore((s) => s.setDraftProjectMentions)
  const issueMentions = useBotStore((s) => s.draftIssueMentions)
  const setIssueMentions = useBotStore((s) => s.setDraftIssueMentions)
  const streaming = useBotStore((s) => s.streaming)
  const controls = useBotStore((s) => s.controls)
  const permissionMode = useBotStore((s) => s.permissionMode)
  const sendMessage = useBotStore((s) => s.sendMessage)
  const abortCurrentTurn = useBotStore((s) => s.abortCurrentTurn)
  const setPermissionMode = useBotStore((s) => s.setPermissionMode)
  const setModel = useBotStore((s) => s.setModel)
  const setThinking = useBotStore((s) => s.setThinking)

  const models = useModelCatalogStore((s) => s.models)
  const refreshing = useModelCatalogStore((s) => s.refreshing)
  const projects = useSessionsStore((s) => s.projects)
  const kanbanItems = useKanbanStore((s) => s.items)
  const kanbanLoaded = useKanbanStore((s) => s.loaded)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const controlsPendingRef = useRef(false)
  const mountedRef = useRef(true)
  const boxRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  const listId = useId()
  const [picker, setPicker] = useState<{ start: number; end: number; query: string } | 'toolbar' | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const query = picker && picker !== 'toolbar' ? picker.query.toLowerCase() : ''

  useEffect(() => {
    if (!kanbanLoaded) {
      void useKanbanStore.getState().init()
    }
  }, [kanbanLoaded])

  const choices = useMemo<BotMentionChoice[]>(() => {
    const projectChoices: BotMentionChoice[] = projects
      .filter(({ name, cwd }) => !query || name.toLowerCase().includes(query) || cwd.toLowerCase().includes(query))
      .map(({ cwd, name }) => ({ kind: 'project', cwd, name }))

    const mentionedSet = new Set(projectMentions)
    const projectNames = new Map(projects.map((p) => [p.cwd, p.name]))
    const unassignedLabel = t('kanban.unassigned')

    const matchingIssues = kanbanItems
      .flatMap((issue) => {
        const projLabel = issue.projectCwd
          ? (projectNames.get(issue.projectCwd) ?? baseName(issue.projectCwd))
          : unassignedLabel
        const detail = [projLabel, ...issue.labels].filter(Boolean).join(' · ')
        if (!issueMentionMatches(issue, query, detail)) return []
        return [{ issue, detail }]
      })
      .sort((a, b) => {
        const aBoost = a.issue.projectCwd && mentionedSet.has(a.issue.projectCwd) ? 0 : 1
        const bBoost = b.issue.projectCwd && mentionedSet.has(b.issue.projectCwd) ? 0 : 1
        if (aBoost !== bBoost) return aBoost - bBoost
        return b.issue.number - a.issue.number
      })
      .slice(0, 20)
      .map(({ issue, detail }): BotMentionChoice => ({ kind: 'issue', issue, detail }))

    return [...projectChoices, ...matchingIssues]
  }, [projects, kanbanItems, projectMentions, query, t])

  const hasAnyCandidates = projects.length > 0 || kanbanItems.length > 0
  const mentionOpen = picker !== null && choices.length > 0
  const selected = Math.min(selectedIndex, Math.max(0, choices.length - 1))

  useEffect(() => {
    if (mentionOpen) selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [mentionOpen, selected, query])

  function updatePicker(input: HTMLTextAreaElement) {
    if (composing.current) return
    const end = input.selectionStart
    const match = end === input.selectionEnd && /(?:^|\s)@([^\s@]*)$/u.exec(input.value.slice(0, end))
    const suffix = match ? /^[^\s@]*/u.exec(input.value.slice(end))?.[0].length ?? 0 : 0
    setPicker(match ? { start: end - match[1].length - 1, end: end + suffix, query: match[1] } : null)
    setSelectedIndex(0)
  }

  const [sending, setSending] = useState(false)
  const [controlsPending, setControlsPending] = useState(false)
  const [controlsError, setControlsError] = useState<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const runControl = useCallback(async (operation: () => Promise<void>): Promise<boolean> => {
    if (controlsPendingRef.current) return false
    controlsPendingRef.current = true
    setControlsPending(true)
    setControlsError(null)
    try {
      await operation()
      return true
    } catch (error) {
      if (mountedRef.current) setControlsError(failureMessage(error))
      return false
    } finally {
      controlsPendingRef.current = false
      if (mountedRef.current) setControlsPending(false)
    }
  }, [])

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const submit = useCallback(async () => {
    const text = draft.trim()
    if ((!text && issueMentions.length === 0) || sending) return
    const currentProjects = projectMentions
    const currentIssues = issueMentions
    setDraft('')
    setProjectMentions([])
    setIssueMentions([])
    const clearedRevision = useBotStore.getState().draftRevision
    setPicker(null)
    setSending(true)
    try {
      await sendMessage({
        text,
        ...(currentProjects.length ? { projectMentions: currentProjects } : {}),
        ...(currentIssues.length ? { issueMentions: currentIssues } : {})
      })
    } catch (error) {
      if (mountedRef.current && useBotStore.getState().draftRevision === clearedRevision) {
        setDraft(draft)
        setProjectMentions(currentProjects)
        setIssueMentions(currentIssues)
      }
      toast.error(failureMessage(error))
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [draft, projectMentions, issueMentions, sending, sendMessage, setDraft, setProjectMentions, setIssueMentions])

  function stripActiveAtToken(): void {
    const input = textareaRef.current
    if (input && picker && picker !== 'toolbar') {
      const { start, end } = picker
      const next = input.value.slice(0, start) + input.value.slice(end)
      setDraft(next)
      requestAnimationFrame(() => {
        if (input.value === next) input.setSelectionRange(start, start)
      })
    }
  }

  function selectChoice(choice: BotMentionChoice) {
    stripActiveAtToken()
    if (choice.kind === 'project') {
      setProjectMentions(
        projectMentions.includes(choice.cwd) ? projectMentions : [...projectMentions, choice.cwd]
      )
    } else {
      const num = choice.issue.number
      setIssueMentions(
        issueMentions.includes(num) ? issueMentions : [...issueMentions, num]
      )
    }
    setPicker(null)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || isComposingKey(event.nativeEvent)) return
    if (picker && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setPicker(null)
      return
    }
    if (mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        selectChoice(choices[selected])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const ModeIcon = MODE_ICONS[permissionMode]
  const hasDraft = draft.trim().length > 0 || issueMentions.length > 0
  const canSend = hasDraft && !sending

  const editor = (
    <>
      {projectMentions.length > 0 || issueMentions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 px-3.5 pt-3">
          {projectMentions.map((cwd) => {
            const proj = projects.find((p) => p.cwd === cwd)
            const name = proj?.name ?? baseName(cwd)
            return (
              <span
                key={`proj:${cwd}`}
                className="inline-flex items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary"
              >
                @{name}
                <button
                  type="button"
                  aria-label={t('bot.actions.dismiss')}
                  onClick={() => setProjectMentions(projectMentions.filter((item) => item !== cwd))}
                  className="hover:text-foreground"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            )
          })}
          {issueMentions.map((num) => {
            const issue = kanbanItems.find((item) => item.number === num)
            const label = issueMentionLabel({ number: num, title: issue?.title ?? '' })
            return (
              <span
                key={`issue:${num}`}
                className="inline-flex max-w-72 items-center gap-1 rounded-md border border-glass-button-border bg-glass-button-background bg-[image:var(--glass-button-sheen)] px-1.5 py-0.5 text-[11px] font-medium text-foreground shadow-glass-button solid:border-border solid:bg-secondary solid:bg-none solid:text-secondary-foreground solid:shadow-none"
              >
                {issue ? <KanbanStatusIcon status={issue.status} className="size-3" /> : null}
                <button
                  type="button"
                  onClick={() => useKanbanStore.getState().openIssueDialog(num)}
                  className="min-w-0 truncate hover:underline"
                >
                  {label}
                </button>
                <button
                  type="button"
                  aria-label={t('bot.actions.dismiss')}
                  onClick={() => setIssueMentions(issueMentions.filter((item) => item !== num))}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            )
          })}
        </div>
      ) : null}

      <InputGroupTextarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onChange={(e) => { setDraft(e.currentTarget.value); updatePicker(e.currentTarget) }}
        onClick={(e) => updatePicker(e.currentTarget)}
        onKeyUp={(e) => {
          if (picker !== 'toolbar' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updatePicker(e.currentTarget)
        }}
        onCompositionStart={() => { composing.current = true; setPicker(null) }}
        onCompositionEnd={(e) => { composing.current = false; updatePicker(e.currentTarget) }}
        onKeyDown={handleKeyDown}
        aria-autocomplete="list"
        aria-controls={mentionOpen ? listId : undefined}
        aria-activedescendant={mentionOpen ? `${listId}-${selected}` : undefined}
        placeholder={t('bot.composer.placeholder')}
        className={cn(composerTextLayout, 'block pb-0 text-inherit placeholder:text-muted-foreground focus:placeholder:opacity-0')}
      />
    </>
  )

  const toolbar = (
    <ComposerControls
      leading={<>
        <ModelPicker
          model={controls?.model ?? null}
          models={models}
          refreshing={refreshing}
          onSelectModel={(item) => runControl(() => setModel(item.provider, item.id))}
          pending={controlsPending}
          error={controlsError}
          disabled={controlsPending}
        />
        <ThinkingPicker
          thinkingLevel={controls?.thinkingLevel ?? 'off'}
          thinkingLevels={controls?.thinkingLevels ?? EMPTY_LEVELS}
          onSelectThinking={(level) => runControl(() => setThinking(level))}
          pending={controlsPending}
          error={controlsError}
          disabled={controlsPending || (controls?.thinkingLevels ?? EMPTY_LEVELS).length <= 1}
        />

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-bot-permission-trigger
                  aria-label={`${t('bot.composer.permissionLabel')}: ${t(`permissions.mode.${permissionMode}`)}`}
                  className={cn(
                    'rounded-full text-muted-foreground hover:text-foreground',
                    permissionMode === 'read-only' && 'text-warning'
                  )}
                >
                  <ModeIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('bot.composer.permissionLabel')} · {t(`permissions.mode.${permissionMode}`)}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="start" className="w-68" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuRadioGroup
              value={permissionMode}
              onValueChange={(value) => {
                void setPermissionMode(value as PermissionMode).catch((error) => toast.error(failureMessage(error)))
              }}
            >
              {PERMISSION_MODES.map((item) => {
                const Icon = MODE_ICONS[item]
                return (
                  <DropdownMenuRadioItem key={item} value={item} className="items-start">
                    <Icon className="mt-0.5 size-3.5" />
                    <span className="flex min-w-0 flex-col">
                      <span>{t(`permissions.mode.${item}`)}</span>
                      <span className="text-xs text-muted-foreground">{t(`permissions.modeHint.${item}`)}</span>
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {hasAnyCandidates ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('bot.composer.mentionProject')}
                aria-expanded={mentionOpen}
                className="rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => {
                  textareaRef.current?.focus()
                  setPicker(mentionOpen ? null : 'toolbar')
                  setSelectedIndex(0)
                }}
              >
                <AtSign className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('bot.composer.mentionProject')}</TooltipContent>
          </Tooltip>
        ) : null}
      </>}
      trailing={
        streaming && !hasDraft ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <InputGroupButton
                variant="secondary"
                size="icon-xs"
                aria-label={t('bot.composer.stopTurn')}
                onClick={() => void abortCurrentTurn()}
                className="rounded-full"
              >
                <span aria-hidden className="size-2.5 rounded-xs bg-destructive bg-(image:--glass-badge-sheen) shadow-glass-badge" />
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent side="top">{t('bot.composer.stopTurn')}</TooltipContent>
          </Tooltip>
        ) : (
          <InputGroupButton
            size="icon-xs"
            variant="default"
            disabled={!canSend}
            aria-label={t('bot.composer.send')}
            onClick={() => void submit()}
            className="rounded-full [&_svg:not([class*='size-'])]:size-3"
          >
            <ArrowUp />
          </InputGroupButton>
        )
      }
    />
  )

  return (
    <Popover open={mentionOpen} onOpenChange={(open) => { if (!open) setPicker(null) }}>
      <PopoverAnchor asChild>
        <ComposerSurface ref={boxRef} data-bot-composer className={className} streaming={streaming} toolbar={toolbar}>
          {editor}
        </ComposerSurface>
      </PopoverAnchor>
      {mentionOpen ? (
        <PopoverContent
          align="start"
          side="top"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && boxRef.current?.contains(event.target)) event.preventDefault()
          }}
          className="w-(--radix-popover-trigger-width) max-w-none gap-0.5 rounded-2xl p-1.5"
        >
          <div id={listId} role="listbox" aria-label={t('bot.composer.mentionProject')} className="max-h-80 overflow-y-auto [scrollbar-width:none]">
            {choices.map((choice, index) => {
              const previous = choices[index - 1]
              const startsGroup = !previous || previous.kind !== choice.kind
              const key = choice.kind === 'project' ? `proj:${choice.cwd}` : `issue:${choice.issue.number}`
              return (
                <Fragment key={key}>
                  {startsGroup ? (
                    <div className={cn('px-3 pb-1 text-xs text-muted-foreground', index > 0 ? 'pt-2' : 'pt-1')}>
                      {t(choice.kind === 'project' ? 'bot.composer.projectsGroup' : 'bot.composer.issuesGroup')}
                    </div>
                  ) : null}
                  <Button
                    id={`${listId}-${index}`}
                    ref={selected === index ? selectedRef : undefined}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected === index}
                    variant="ghost"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => selectChoice(choice)}
                    className={cn(
                      'h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-3 text-xs font-normal transition-none hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent',
                      selected === index && 'bg-glass-prompt-foreground/8 solid:bg-accent'
                    )}
                  >
                    {choice.kind === 'project' ? (
                      <>
                        <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="shrink-0">{choice.name}</span>
                        <span className="min-w-0 truncate text-muted-foreground">{choice.cwd}</span>
                      </>
                    ) : (
                      <>
                        <KanbanStatusIcon status={choice.issue.status} className="size-3.5" />
                        <span className="max-w-72 shrink-0 truncate">{issueMentionLabel(choice.issue)}</span>
                        <span className="min-w-0 truncate text-muted-foreground">{choice.detail}</span>
                      </>
                    )}
                  </Button>
                </Fragment>
              )
            })}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
