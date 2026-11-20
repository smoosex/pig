/**
 * Dedicated Bot input surface:
 * - Immediate send-and-clear with zero QueuedMessageRow bar
 * - Strict IME composition guard (Enter never sends during composition)
 * - @project mention picker for opened projects
 * - Independent Bot model/thinking picker + low-key permission mode switcher (defaults to full-access)
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowUp, AtSign, Eye, FolderKanban, ShieldCheck, ShieldOff, X, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { ThinkingLevel } from '../../../../shared/api'
import { PERMISSION_MODES, type PermissionMode } from '../../../../shared/permissions'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useSessionsStore } from '../../stores/sessions'
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

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const controlsPendingRef = useRef(false)
  const mountedRef = useRef(true)
  const [mentions, setMentions] = useState<string[]>([])
  const mentionRevision = useRef(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  const listId = useId()
  const [picker, setPicker] = useState<{ start: number; end: number; query: string } | 'toolbar' | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const query = picker && picker !== 'toolbar' ? picker.query.toLowerCase() : ''
  const choices = projects.filter(({ name, cwd }) => name.toLowerCase().includes(query) || cwd.toLowerCase().includes(query))
  const mentionOpen = picker !== null && choices.length > 0
  const selected = Math.min(selectedIndex, choices.length - 1)

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
    if (!text || sending) return
    const currentMentions = mentions
    // Immediate landing & clear so rapid follow-ups never feel blocked.
    setDraft('')
    const clearedRevision = useBotStore.getState().draftRevision
    const clearedMentionsRevision = mentionRevision.current
    setMentions([])
    setPicker(null)
    setSending(true)
    try {
      await sendMessage({
        text,
        ...(currentMentions.length ? { projectMentions: currentMentions } : {})
      })
    } catch (error) {
      if (mountedRef.current && useBotStore.getState().draftRevision === clearedRevision &&
          mentionRevision.current === clearedMentionsRevision) {
        setDraft(draft)
        setMentions(currentMentions)
      }
      toast.error(failureMessage(error))
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [draft, mentions, sending, sendMessage, setDraft])

  function selectProject(cwd: string) {
    const input = textareaRef.current
    if (input && picker && picker !== 'toolbar') {
      const { start, end } = picker
      const next = input.value.slice(0, start) + input.value.slice(end)
      setDraft(next)
      requestAnimationFrame(() => {
        if (input.value === next) input.setSelectionRange(start, start)
      })
    }
    mentionRevision.current++
    setMentions((prev) => prev.includes(cwd) ? prev : [...prev, cwd])
    setPicker(null)
    input?.focus()
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
        selectProject(choices[selected].cwd)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const ModeIcon = MODE_ICONS[permissionMode]
  const canSend = draft.trim().length > 0 && !sending

  const editor = (
    <>
      {mentions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 px-3.5 pt-3">
          {mentions.map((cwd) => {
            const proj = projects.find((p) => p.cwd === cwd)
            const name = proj?.name ?? cwd.split('/').pop() ?? cwd
            return (
              <span
                key={cwd}
                className="inline-flex items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary"
              >
                @{name}
                <button
                  type="button"
                  aria-label={t('bot.actions.dismiss')}
                  onClick={() => {
                    mentionRevision.current++
                    setMentions((prev) => prev.filter((item) => item !== cwd))
                  }}
                  className="hover:text-foreground"
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
          {/* Independent Bot model & thinking pickers matching workspace ComposerToolbar */}
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

          {/* Low-key Bot permission mode switcher (defaults to full-access) */}
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

          {/* @ Project mention picker */}
          {projects.length > 0 ? (
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
      trailing={<>
          {streaming ? (
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
          ) : null}

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
      </>}
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
          {choices.map((project, index) => (
            <Button
              key={project.cwd}
              id={`${listId}-${index}`}
              ref={selected === index ? selectedRef : undefined}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={selected === index}
              variant="ghost"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => selectProject(project.cwd)}
              className={cn(
                'h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-3 text-xs font-normal transition-none hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent',
                selected === index && 'bg-glass-prompt-foreground/8 solid:bg-accent'
              )}
            >
              <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0">{project.name}</span>
              <span className="min-w-0 truncate text-muted-foreground">{project.cwd}</span>
            </Button>
          ))}
        </div>
      </PopoverContent>
    ) : null}
    </Popover>
  )
}
