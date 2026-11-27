/**
 * Dedicated Bot input surface built on the shared workspace Tiptap composer editor:
 * - Immediate send-and-clear with zero QueuedMessageRow bar
 * - Image paste/drop thumbnails + zoom preview, inline long-paste chips, and external OS file/folder drops
 * - Strict IME composition guard + workspace sendShortcut & composer.focus shortcut parity
 * - Dual-group `@` mention picker for opened projects AND Kanban issues (prioritizing issues of mentioned projects)
 * - Independent Bot model/thinking picker + low-key permission mode switcher (defaults to full-access)
 */
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, type Editor } from '@tiptap/react'
import { ArrowUp, AtSign, Eye, FolderKanban, ShieldCheck, ShieldOff, X, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { ThinkingLevel } from '../../../../shared/api'
import { fileMentionText } from '../../../../shared/file-mentions'
import type { KanbanIssue } from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { PERMISSION_MODES, type PermissionMode } from '../../../../shared/permissions'
import { skillMentionText } from '../../../../shared/skill-mentions'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { matchesShortcut } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useKanbanStore } from '../../stores/kanban'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useSessionsStore } from '../../stores/sessions'
import { useSettingsStore } from '../../stores/settings'
import { ComposerDropHint } from '../composer/ComposerDropHint'
import { ComposerImages } from '../composer/ComposerImages'
import { ComposerControls, ComposerSurface, composerTextLayout } from '../composer/ComposerSurface'
import { trimComposer } from '../composer/document'
import { activeFileDrag, classifyComposerDrag, type ComposerDragKind } from '../composer/file-drag'
import { issueMentionLabel, issueMentionMatches, issueMentionText, type IssueMention } from '../composer/issue-mentions'
import { ModelPicker, ThinkingPicker } from '../composer/ModelControls'
import { tabMentionText, type TabMention } from '../composer/tab-mentions'
import { useComposerEditor } from '../composer/useComposerEditor'
import { useComposerImages } from '../composer/useComposerImages'
import { FileMentionContext } from '../FileMentionChip'
import { ImagePreview } from '../ImagePreview'
import { KanbanStatusIcon } from '../kanban/kanban-icons'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { InputGroupButton } from '../ui/input-group'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const BOT_DRAFT_KEY = 'bot'
const EMPTY_LEVELS: ThinkingLevel[] = ['off']

const MODE_ICONS: Record<PermissionMode, LucideIcon> = {
  'read-only': Eye,
  default: ShieldCheck,
  'full-access': ShieldOff
}

type BotMentionChoice =
  | { kind: 'project'; cwd: string; name: string }
  | { kind: 'issue'; issue: KanbanIssue; detail: string }

interface BotMentionTarget {
  from: number
  to: number
  query: string
}

interface TextSegment {
  text: string
  textFrom: number
  docFrom: number
  splittable: boolean
}

function pieceText(node: {
  isText: boolean
  text?: string | null
  type: { name: string }
  attrs: Record<string, unknown>
}): string {
  if (node.isText) return node.text ?? ''
  if (node.type.name === 'hardBreak') return '\n'
  if (node.type.name === 'pastedText') return String(node.attrs.text ?? '')
  if (node.type.name === 'fileMention') return fileMentionText(String(node.attrs.path ?? ''))
  if (node.type.name === 'skillMention') return skillMentionText(String(node.attrs.name ?? ''))
  if (node.type.name === 'tabMention') return tabMentionText(node.attrs as unknown as TabMention)
  if (node.type.name === 'issueMention') return issueMentionText(node.attrs as unknown as IssueMention)
  return ''
}

/**
 * Finds a plain-text `@query` token around the caret without splitting atom nodes (`pastedText`, `fileMention`).
 */
function readBotMentionTarget(editor: Editor): BotMentionTarget | null {
  const { selection } = editor.state
  if (!selection.empty) return null
  const $from = selection.$from
  const parent = $from.parent
  if (!parent.isTextblock) return null
  const blockStart = $from.start()

  const segments: TextSegment[] = []
  let length = 0
  parent.forEach((node, offset) => {
    const text = pieceText(node)
    segments.push({ text, textFrom: length, docFrom: blockStart + offset, splittable: node.isText })
    length += text.length
  })

  let caretText = length
  for (const segment of segments) {
    const docTo = segment.docFrom + (segment.splittable ? segment.text.length : 1)
    if (selection.from <= docTo) {
      caretText = segment.splittable
        ? segment.textFrom + Math.max(0, selection.from - segment.docFrom)
        : selection.from === segment.docFrom
          ? segment.textFrom
          : segment.textFrom + segment.text.length
      break
    }
  }

  const caretHolder = [...segments]
    .reverse()
    .find((segment) => segment.splittable && segment.textFrom <= caretText && caretText <= segment.textFrom + segment.text.length)
  if (!caretHolder) return null

  const fullBefore = segments.map((segment) => segment.text).join('').slice(0, caretText)
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(fullBefore)
  if (!match) return null
  const tokenStart = caretText - match[1].length - 1
  if (tokenStart < caretHolder.textFrom) return null

  const offsetInHolder = caretText - caretHolder.textFrom
  const suffix = /^[^\s@]*/u.exec(caretHolder.text.slice(offsetInHolder))?.[0].length ?? 0
  return {
    from: caretHolder.docFrom + (tokenStart - caretHolder.textFrom),
    to: caretHolder.docFrom + offsetInHolder + suffix,
    query: match[1]
  }
}

export function BotComposer({
  autoFocus = false,
  isActive = true,
  className
}: {
  autoFocus?: boolean
  isActive?: boolean
  className?: string
}) {
  const t = useT()
  const storeDraft = useBotStore((s) => s.draftInput)
  const setStoreDraft = useBotStore((s) => s.setDraftInput)
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
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)

  const models = useModelCatalogStore((s) => s.models)
  const refreshing = useModelCatalogStore((s) => s.refreshing)
  const projects = useSessionsStore((s) => s.projects)
  const kanbanItems = useKanbanStore((s) => s.items)
  const kanbanLoaded = useKanbanStore((s) => s.loaded)

  const controlsPendingRef = useRef(false)
  const mountedRef = useRef(true)
  const boxRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const [picker, setPicker] = useState<BotMentionTarget | 'toolbar' | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [controlsPending, setControlsPending] = useState(false)
  const [controlsError, setControlsError] = useState<string | null>(null)
  const [dragKind, setDragKind] = useState<ComposerDragKind | null>(null)

  const attachments = useComposerImages(BOT_DRAFT_KEY)
  const keyHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false)
  const document = useComposerEditor({
    sessionId: BOT_DRAFT_KEY,
    isActive,
    cwd: null,
    acceptAnyWorkspaceFileDrag: true,
    placeholderText: t('bot.composer.placeholder'),
    ariaLabel: t('bot.composer.placeholder'),
    onKeyDown: (event) => keyHandlerRef.current(event),
    onPasteImages: attachments.add
  })
  const { editor, draft, dropExternal } = document

  // Bidirectional sync between external `useBotStore.draftInput` callers (starter chips, tests, issue actions)
  // and the live Tiptap document, preserving rich chips when text already matches.
  const prevStoreDraftRef = useRef(document.getDraft().text)
  useLayoutEffect(() => {
    if (storeDraft !== prevStoreDraftRef.current) {
      prevStoreDraftRef.current = storeDraft
      if (editor && !editor.isDestroyed && storeDraft !== document.getDraft().text) {
        document.replaceText(storeDraft)
      }
      return
    }
    if (draft.text !== storeDraft) {
      prevStoreDraftRef.current = draft.text
      setStoreDraft(draft.text)
    }
  }, [storeDraft, draft.text, editor, document, setStoreDraft])

  useEffect(() => {
    if (!kanbanLoaded) {
      void useKanbanStore.getState().init()
    }
  }, [kanbanLoaded])

  useEffect(() => {
    if (!dragKind) return
    const clear = () => setDragKind(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dragKind])

  useEffect(() => {
    if (!editor) return
    const onUpdate = () => {
      const target = readBotMentionTarget(editor)
      setPicker(target)
      setSelectedIndex(0)
    }
    const onSelection = () => {
      const target = readBotMentionTarget(editor)
      setPicker((current) => {
        if (target) return target
        return current === 'toolbar' ? current : null
      })
      if (target) setSelectedIndex(0)
    }
    editor.on('update', onUpdate)
    editor.on('selectionUpdate', onSelection)
    return () => {
      editor.off('update', onUpdate)
      editor.off('selectionUpdate', onSelection)
    }
  }, [editor])

  const query = picker && picker !== 'toolbar' ? picker.query.toLowerCase() : ''

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
  const mentionOpen = !dragKind && picker !== null && choices.length > 0
  const selected = Math.min(selectedIndex, Math.max(0, choices.length - 1))

  useEffect(() => {
    if (mentionOpen) selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [mentionOpen, selected, query])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
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
    if (autoFocus && editor && !editor.isDestroyed) {
      editor.commands.focus()
    }
  }, [autoFocus, editor])

  const submit = useCallback(async () => {
    if (!editor || sending) return
    const serialized = document.getDraft()
    const currentImages = attachments.getImages()
    const prompt = trimComposer(serialized)
    if (
      !prompt.text &&
      prompt.attachments.length === 0 &&
      currentImages.length === 0 &&
      issueMentions.length === 0
    ) {
      return
    }

    const savedJson = editor.getJSON()
    const savedImages = currentImages.map(({ id, mimeType, data }) => ({ id, mimeType, data }))
    const imagePayload = savedImages.map(({ mimeType, data }) => ({ mimeType, data }))
    const currentProjects = projectMentions
    const currentIssues = issueMentions

    document.clear()
    attachments.clear()
    prevStoreDraftRef.current = ''
    setStoreDraft('')
    setProjectMentions([])
    setIssueMentions([])
    const clearedRevision = useBotStore.getState().draftRevision
    setPicker(null)
    setSending(true)

    try {
      await sendMessage({
        text: prompt.text,
        ...(imagePayload.length ? { images: imagePayload } : {}),
        ...(prompt.attachments.length ? { textAttachments: prompt.attachments } : {}),
        ...(prompt.mentions.length ? { fileMentions: prompt.mentions } : {}),
        ...(currentProjects.length ? { projectMentions: currentProjects } : {}),
        ...(currentIssues.length ? { issueMentions: currentIssues } : {})
      })
    } catch (error) {
      if (
        mountedRef.current &&
        useBotStore.getState().draftRevision === clearedRevision &&
        !document.getDraft().text &&
        attachments.getImages().length === 0
      ) {
        document.restore(savedJson)
        if (savedImages.length > 0) attachments.restore(savedImages)
        prevStoreDraftRef.current = serialized.text
        setStoreDraft(serialized.text)
        setProjectMentions(currentProjects)
        setIssueMentions(currentIssues)
      }
      toast.error(failureMessage(error))
    } finally {
      if (mountedRef.current) {
        setSending(false)
        editor.commands.focus()
      }
    }
  }, [
    editor,
    sending,
    document,
    attachments,
    projectMentions,
    issueMentions,
    sendMessage,
    setStoreDraft,
    setProjectMentions,
    setIssueMentions
  ])

  function selectChoice(choice: BotMentionChoice) {
    if (editor && picker && picker !== 'toolbar') {
      const live = readBotMentionTarget(editor) ?? picker
      editor.chain().focus().deleteRange({ from: live.from, to: live.to }).run()
    } else {
      editor?.commands.focus()
    }
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
  }

  keyHandlerRef.current = (event: KeyboardEvent): boolean => {
    if (matchesShortcut(event, 'composer.focus')) {
      event.preventDefault()
      return true
    }
    if (picker && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setPicker(null)
      return true
    }
    if (mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length)
        return true
      }
      if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        selectChoice(choices[selected])
        return true
      }
    }
    if (event.key !== 'Enter') return false
    const sendNow = sendShortcut === 'enter' ? !event.shiftKey : event.shiftKey
    if (!sendNow) return false
    event.preventDefault()
    void submit()
    return true
  }

  const mentionContext = useMemo(
    () => ({ cwd: null, sessionId: null, preferredCwds: projectMentions }),
    [projectMentions]
  )

  const ModeIcon = MODE_ICONS[permissionMode]
  const hasDraft = Boolean(
    draft.text.trim().length > 0 ||
    draft.attachments.length > 0 ||
    attachments.images.length > 0 ||
    issueMentions.length > 0
  )
  const canSend = hasDraft && !sending

  const editorBody = (
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

      <FileMentionContext.Provider value={mentionContext}>
        <EditorContent
          editor={editor}
          className={cn(
            composerTextLayout,
            '[&_.ProseMirror]:min-h-16 [&_.ProseMirror]:outline-none [&_.ProseMirror:not(:focus)]:caret-transparent [&_.ProseMirror_p]:m-0 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror:focus_.is-editor-empty:first-child::before]:hidden',
            dragKind && '[&_.ProseMirror]:caret-transparent'
          )}
        />
      </FileMentionContext.Provider>
      <ComposerImages
        images={attachments.images}
        onPreview={attachments.setPreview}
        onRemove={attachments.remove}
        disabled={sending}
      />
      {attachments.error ? (
        <p role="alert" className="px-3.5 pb-1.5 text-xs text-destructive">
          {attachments.error}
        </p>
      ) : null}
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
                  const next = mentionOpen ? null : 'toolbar'
                  editor?.commands.focus()
                  setPicker(next)
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
    <>
      <Popover open={mentionOpen} onOpenChange={(open) => { if (!open) setPicker(null) }}>
        <PopoverAnchor asChild>
          <ComposerSurface
            ref={boxRef}
            data-bot-composer
            className={className}
            streaming={streaming}
            dragOver={dragKind !== null}
            onDragOver={(event) => {
              const native = event.nativeEvent
              const kind = classifyComposerDrag(native, {
                editable: Boolean(editor?.isEditable),
                disabled: sending,
                cwd: null,
                acceptAnyWorkspaceFileDrag: true,
                internalDragging: Boolean(editor?.view.dragging)
              })
              setDragKind(kind)
              if (kind) {
                if (!event.defaultPrevented) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }
              } else if (activeFileDrag(native) && !event.defaultPrevented) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'none'
              }
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
              setDragKind(null)
            }}
            onDrop={(event) => {
              setDragKind(null)
              if (!event.defaultPrevented) dropExternal(event.nativeEvent)
            }}
            before={<ComposerDropHint kind={dragKind} />}
            toolbar={toolbar}
          >
            {editorBody}
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
      <ImagePreview src={attachments.preview} onClose={() => attachments.setPreview(null)} />
    </>
  )
}
