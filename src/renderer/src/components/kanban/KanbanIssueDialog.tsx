/**
 * Linear-inspired Kanban Issue Composer & Detail Modal:
 * - Clean breadcrumb header (`Project › New issue` / `#12`) with Expand/Collapse + Close controls
 * - Seamless borderless document canvas (large borderless title + auto-sizing borderless description)
 * - Direct clipboard image paste (`⌘V`), drag-and-drop image files, and footer paperclip attachment button
 * - Compact bottom property pills (`Status`, `Priority`, `Project`, `Labels` — no Assignee)
 *   with built-in `Feature` / `Bug` / `Improvement` colored-dot labels + custom label creation
 * - Footer `Create more` toggle for rapid issue capture
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import {
  ArrowUpRight,
  Bot,
  Box,
  Check,
  Eye,
  Inbox,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  Paperclip,
  PenLine,
  Plus,
  Tag,
  Trash2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import {
  KANBAN_DEFAULT_LABELS,
  KANBAN_PRIORITIES,
  KANBAN_STATUSES,
  kanbanImageUrl,
  type KanbanImageInput,
  type KanbanIssue,
  type KanbanPriority,
  type KanbanStatus
} from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useKanbanStore } from '../../stores/kanban'
import { useSessionsStore } from '../../stores/sessions'
import { clipboardImages } from '../composer/useComposerImages'
import { ImagePreview } from '../ImagePreview'
import { MarkdownText } from '../MarkdownText'
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
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Switch } from '../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import type { KanbanCardCallbacks } from './KanbanCard'
import { KanbanLabelDot, KanbanPriorityIcon, KanbanStackedLabelDots, KanbanStatusIcon } from './kanban-icons'

type DialogImageItem =
  | { kind: 'existing'; id: string; url: string; name?: string }
  | { kind: 'new'; key: string; mimeType: string; data: string; url: string; name?: string }

const pillButtonClass =
  'inline-flex h-6.5 items-center gap-1.5 rounded-full border border-glass-border bg-glass-prompt-foreground/5 px-2.5 text-xs font-normal text-foreground/90 transition-colors outline-none hover:bg-glass-prompt-foreground/10 focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring solid:border-border solid:bg-muted/45 solid:hover:bg-accent'

function readImageFile(file: File): Promise<Extract<DialogImageItem, { kind: 'new' }>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to read image'))
        return
      }
      const comma = reader.result.indexOf(',')
      const data = comma === -1 ? reader.result : reader.result.slice(comma + 1)
      if (!data) {
        reject(new Error('Empty image file'))
        return
      }
      resolve({
        kind: 'new',
        key: crypto.randomUUID(),
        mimeType: file.type || 'image/png',
        data,
        url: URL.createObjectURL(file),
        ...(file.name ? { name: file.name } : {})
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.onabort = () => reject(new Error('Image read aborted'))
    reader.readAsDataURL(file)
  })
}

export function KanbanIssueDialog({
  callbacks,
  onLocateInBoard,
  onOpenLinkedSession,
  isBoardVisible
}: {
  callbacks: KanbanCardCallbacks
  onLocateInBoard: (issue: KanbanIssue) => void
  onOpenLinkedSession: (sessionId: string, cwd: string) => void
  isBoardVisible: boolean
}) {
  const t = useT()
  const dialog = useKanbanStore((s) => s.dialog)
  const items = useKanbanStore((s) => s.items)
  const loaded = useKanbanStore((s) => s.loaded)
  const closeDialog = useKanbanStore((s) => s.closeDialog)
  const createIssue = useKanbanStore((s) => s.createIssue)
  const updateIssue = useKanbanStore((s) => s.updateIssue)
  const deleteIssue = useKanbanStore((s) => s.deleteIssue)

  const projects = useSessionsStore((s) => s.projects)
  const botTasks = useBotStore((s) => s.tasks)

  useEffect(() => {
    if (dialog && !loaded) {
      void useKanbanStore.getState().init()
    }
  }, [dialog, loaded])

  const existingIssue = useMemo(
    () => (dialog?.mode === 'edit' ? items.find((item) => item.number === dialog.number) ?? null : null),
    [dialog, items]
  )

  const [expanded, setExpanded] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [previewMode, setPreviewMode] = useState(false)
  const [status, setStatus] = useState<KanbanStatus>('todo')
  const [priority, setPriority] = useState<KanbanPriority>('none')
  const [projectCwd, setProjectCwd] = useState<string | null>(null)
  const [labels, setLabels] = useState<string[]>([])
  const [labelMenuOpen, setLabelMenuOpen] = useState(false)
  const [labelQuery, setLabelQuery] = useState('')
  const [images, setImages] = useState<DialogImageItem[]>([])
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const titleInputRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const blobUrlsRef = useRef<Set<string>>(new Set())

  const revokeBlobs = useCallback(() => {
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url)
    blobUrlsRef.current.clear()
  }, [])

  useEffect(() => revokeBlobs, [revokeBlobs])

  const dialogKey =
    dialog === null
      ? 'closed'
      : dialog.mode === 'create'
        ? `create:${dialog.defaultProjectCwd ?? ''}:${dialog.defaultStatus ?? ''}`
        : `edit:${dialog.number}:${existingIssue ? 'ready' : 'missing'}`

  useEffect(() => {
    setConfirmDeleteOpen(false)
    setLabelMenuOpen(false)
    setLabelQuery('')
    setDragActive(false)
    setPreviewSrc(null)
    revokeBlobs()

    if (!dialog) return
    if (dialog.mode === 'create') {
      setTitle('')
      setDescription('')
      setPreviewMode(false)
      setStatus(dialog.defaultStatus ?? 'todo')
      setPriority('none')
      setProjectCwd(dialog.defaultProjectCwd)
      setLabels([])
      setImages([])
      return
    }
    if (existingIssue) {
      setTitle(existingIssue.title)
      setDescription(existingIssue.description)
      setPreviewMode(false)
      setStatus(existingIssue.status)
      setPriority(existingIssue.priority)
      setProjectCwd(existingIssue.projectCwd)
      setLabels(existingIssue.labels)
      setImages(
        existingIssue.images.map((img) => ({
          kind: 'existing',
          id: img.id,
          url: kanbanImageUrl(img.id),
          ...(img.name ? { name: img.name } : {})
        }))
      )
    }
  }, [dialogKey, revokeBlobs])

  // Auto-size borderless description textarea cleanly without scrollbars.
  useLayoutEffect(() => {
    const el = descRef.current
    if (!el || previewMode) return
    el.style.height = '0px'
    el.style.height = `${Math.max(112, el.scrollHeight)}px`
  }, [description, previewMode, expanded, dialogKey])

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith('image/'))
      if (imageFiles.length === 0) return
      const settled = await Promise.allSettled(imageFiles.map(readImageFile))
      const next: DialogImageItem[] = []
      let hadError = false
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          blobUrlsRef.current.add(item.value.url)
          next.push(item.value)
        } else {
          hadError = true
        }
      }
      if (next.length > 0) {
        setImages((prev) => [...prev, ...next].slice(0, 12))
      }
      if (hadError) {
        toast.error(t('kanban.imageReadFailed'))
      }
    },
    [t]
  )

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
      const pasted = clipboardImages(event.nativeEvent)
      if (pasted.length === 0) return
      event.preventDefault()
      void addImageFiles(pasted)
    },
    [addImageFiles]
  )

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!event.dataTransfer?.files?.length) return
      const dropped = [...event.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
      if (dropped.length === 0) return
      event.preventDefault()
      setDragActive(false)
      void addImageFiles(dropped)
    },
    [addImageFiles]
  )

  const removeImage = (index: number) => {
    setImages((prev) => {
      const target = prev[index]
      if (target?.kind === 'new') {
        URL.revokeObjectURL(target.url)
        blobUrlsRef.current.delete(target.url)
      }
      if (target && previewSrc === target.url) {
        setPreviewSrc(null)
      }
      return prev.filter((_, i) => i !== index)
    })
  }

  const projectOptions = useMemo(() => {
    const list = projects.map((p) => ({ cwd: p.cwd, name: p.name, closed: false }))
    if (projectCwd && !list.some((p) => p.cwd === projectCwd)) {
      list.push({ cwd: projectCwd, name: `${baseName(projectCwd)} (${t('kanban.unopenedProject')})`, closed: true })
    }
    return list
  }, [projects, projectCwd, t])

  const selectedProjectName = useMemo(() => {
    if (!projectCwd) return null
    return projectOptions.find((p) => p.cwd === projectCwd)?.name ?? baseName(projectCwd)
  }, [projectCwd, projectOptions])

  // Always offer the 3 built-in Linear labels (`Feature`, `Bug`, `Improvement`) plus any custom labels in use.
  const allAvailableLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const builtin of KANBAN_DEFAULT_LABELS) {
      map.set(builtin.toLowerCase(), builtin)
    }
    for (const issue of items) {
      for (const l of issue.labels) {
        const key = l.toLowerCase()
        if (!map.has(key)) map.set(key, l)
      }
    }
    for (const l of labels) {
      const key = l.toLowerCase()
      if (!map.has(key)) map.set(key, l)
    }
    return [...map.values()]
  }, [items, labels])

  const filteredLabelOptions = useMemo(() => {
    const q = labelQuery.trim().toLowerCase()
    if (!q) return allAvailableLabels
    return allAvailableLabels.filter((l) => l.toLowerCase().includes(q))
  }, [allAvailableLabels, labelQuery])

  const exactLabelExists = useMemo(() => {
    const q = labelQuery.trim().toLowerCase()
    return !q || allAvailableLabels.some((l) => l.toLowerCase() === q)
  }, [allAvailableLabels, labelQuery])

  const toggleLabel = (candidate: string) => {
    const trimmed = candidate.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    setLabels((prev) =>
      prev.some((item) => item.toLowerCase() === key)
        ? prev.filter((item) => item.toLowerCase() !== key)
        : [...prev, trimmed]
    )
  }

  const createCustomLabel = () => {
    const trimmed = labelQuery.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    if (!labels.some((item) => item.toLowerCase() === key)) {
      setLabels((prev) => [...prev, trimmed])
    }
    setLabelQuery('')
  }

  const handleSave = async () => {
    const cleanTitle = title.trim()
    if (!cleanTitle || saving || !dialog) return

    const imageInputs: KanbanImageInput[] = images.map((img) =>
      img.kind === 'existing'
        ? { id: img.id }
        : { mimeType: img.mimeType, data: img.data, ...(img.name ? { name: img.name } : {}) }
    )

    setSaving(true)
    try {
      if (dialog.mode === 'create') {
        await createIssue({
          title: cleanTitle,
          description,
          status,
          priority,
          projectCwd,
          labels,
          images: imageInputs
        })
        if (createMore) {
          revokeBlobs()
          setTitle('')
          setDescription('')
          setImages([])
          setPreviewMode(false)
          requestAnimationFrame(() => titleInputRef.current?.focus())
          return
        }
      } else {
        await updateIssue({
          number: dialog.number,
          title: cleanTitle,
          description,
          status,
          priority,
          projectCwd,
          labels,
          images: imageInputs
        })
      }
      closeDialog()
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (dialog?.mode !== 'edit' || deleting) return
    setDeleting(true)
    try {
      await deleteIssue(dialog.number)
      setConfirmDeleteOpen(false)
    } catch (error) {
      toast.error(failureMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  const linkedBotTasks = useMemo(() => {
    if (!existingIssue) return []
    return existingIssue.linkedBotTaskIds
      .map((id) => botTasks.find((task) => task.taskId === id))
      .filter((task): task is NonNullable<typeof task> => Boolean(task))
  }, [existingIssue, botTasks])

  return (
    <>
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent
          showCloseButton={false}
          onPaste={handlePaste}
          onDragOver={(e) => {
            if ([...(e.dataTransfer?.items ?? [])].some((item) => item.type.startsWith('image/'))) {
              e.preventDefault()
              if (!dragActive) setDragActive(true)
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragActive(false)
          }}
          onDrop={handleDrop}
          className={cn(
            'flex max-h-[86vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 transition-[max-width] duration-150',
            expanded ? 'sm:max-w-4xl' : 'sm:max-w-[640px]',
            dragActive && 'ring-2 ring-primary/50'
          )}
        >
          <DialogTitle className="sr-only">
            {dialog?.mode === 'create'
              ? t('kanban.newIssue')
              : existingIssue
                ? `#${existingIssue.number} ${existingIssue.title}`
                : t('kanban.editIssue')}
          </DialogTitle>

          {/* Linear-style top breadcrumb + window controls */}
          <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-4 pb-1">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-flex max-w-44 items-center gap-1 rounded-md border border-glass-border bg-glass-prompt-foreground/5 px-1.5 py-0.5 font-medium text-foreground/85 solid:border-border solid:bg-muted/60">
                {selectedProjectName ? (
                  <>
                    <Box className="size-3 shrink-0 text-primary" aria-hidden="true" />
                    <span className="truncate">{selectedProjectName}</span>
                  </>
                ) : (
                  <>
                    <Inbox className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>{t('kanban.unassigned')}</span>
                  </>
                )}
              </span>
              <span aria-hidden="true" className="text-muted-foreground/50">›</span>
              <span className="font-medium text-foreground/90">
                {dialog?.mode === 'create'
                  ? t('kanban.newIssue')
                  : existingIssue
                    ? `#${existingIssue.number}`
                    : t('kanban.editIssue')}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              {existingIssue ? (
                <>
                  {!isBoardVisible ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('kanban.locateInBoard')}
                          onClick={() => {
                            closeDialog()
                            onLocateInBoard(existingIssue)
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ArrowUpRight className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('kanban.locateInBoard')}</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('kanban.startInSession')}
                        onClick={() => {
                          closeDialog()
                          callbacks.onStartInSession(existingIssue)
                        }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <MessageSquarePlus className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t('kanban.startInSession')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('kanban.sendToBot')}
                        onClick={() => {
                          closeDialog()
                          callbacks.onSendToBot(existingIssue)
                        }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Bot className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t('kanban.sendToBot')}</TooltipContent>
                  </Tooltip>
                </>
              ) : null}

              {description.trim() ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t(previewMode ? 'kanban.write' : 'kanban.preview')}
                      onClick={() => setPreviewMode((p) => !p)}
                      className={cn(
                        'text-muted-foreground hover:text-foreground',
                        previewMode && 'text-primary'
                      )}
                    >
                      {previewMode ? <PenLine className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t(previewMode ? 'kanban.write' : 'kanban.preview')}
                  </TooltipContent>
                </Tooltip>
              ) : null}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t(expanded ? 'kanban.collapse' : 'kanban.expand')}
                    onClick={() => setExpanded((v) => !v)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t(expanded ? 'kanban.collapse' : 'kanban.expand')}
                </TooltipContent>
              </Tooltip>

              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('common.cancel')}
                onClick={closeDialog}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {dialog?.mode === 'edit' && !existingIssue ? (
            <div className="px-5 py-10 text-center text-xs text-muted-foreground">
              {t('kanban.issueNotFound', { number: dialog.number })}
            </div>
          ) : (
            <>
              {/* Borderless document canvas */}
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <input
                  ref={titleInputRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.currentTarget.value)}
                  onCompositionStart={() => { composingRef.current = true }}
                  onCompositionEnd={() => { composingRef.current = false }}
                  onKeyDown={(e) => {
                    if (composingRef.current || isComposingKey(e.nativeEvent)) return
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void handleSave()
                      return
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      setPreviewMode(false)
                      requestAnimationFrame(() => descRef.current?.focus())
                    }
                  }}
                  placeholder={t('kanban.fields.titlePlaceholder')}
                  aria-label={t('kanban.fields.title')}
                  autoFocus={dialog?.mode === 'create'}
                  className="w-full bg-transparent text-lg font-semibold tracking-tight text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground/50"
                />

                <div className="mt-2">
                  {previewMode && description.trim() ? (
                    <div
                      onClick={() => setPreviewMode(false)}
                      className="min-h-28 cursor-text text-sm leading-relaxed text-foreground/90"
                    >
                      <MarkdownText text={description} />
                    </div>
                  ) : (
                    <textarea
                      ref={descRef}
                      rows={4}
                      value={description}
                      onChange={(e) => setDescription(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (isComposingKey(e.nativeEvent)) return
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void handleSave()
                        }
                      }}
                      placeholder={t('kanban.fields.descriptionPlaceholder')}
                      aria-label={t('kanban.fields.description')}
                      className={cn(
                        'w-full resize-none bg-transparent text-sm leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/45',
                        expanded ? 'min-h-56' : 'min-h-28'
                      )}
                    />
                  )}
                </div>

                {/* Pasted & attached images strip */}
                {images.length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 pb-1">
                    {images.map((img, idx) => (
                      <div
                        key={img.kind === 'existing' ? img.id : img.key}
                        className="group/issue-img relative overflow-hidden rounded-lg border border-glass-border bg-glass-prompt-foreground/4 solid:border-border solid:bg-muted/30"
                      >
                        <button
                          type="button"
                          onClick={() => setPreviewSrc(img.url)}
                          className="block cursor-zoom-in outline-none"
                        >
                          <img
                            src={img.url}
                            alt={img.name ?? ''}
                            className="h-20 max-w-40 object-cover"
                          />
                        </button>
                        <button
                          type="button"
                          aria-label={t('bot.actions.dismiss')}
                          onClick={() => removeImage(idx)}
                          className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/85 text-foreground opacity-0 shadow-xs transition-opacity group-hover/issue-img:opacity-100 hover:bg-background"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Linked Sessions & Bot Tasks */}
                {existingIssue && (existingIssue.linkedSessions.length > 0 || linkedBotTasks.length > 0) ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 pb-1">
                    {existingIssue.linkedSessions.map((entry) => (
                      <button
                        key={`sess:${entry.sessionId}`}
                        type="button"
                        onClick={() => {
                          closeDialog()
                          onOpenLinkedSession(entry.sessionId, entry.cwd)
                        }}
                        className={cn(pillButtonClass, 'h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground')}
                      >
                        <MessageSquare className="size-3" />
                        <span>{t('kanban.linkedSession')} · {entry.sessionId.slice(0, 8)}</span>
                        <ArrowUpRight className="size-3" />
                      </button>
                    ))}
                    {linkedBotTasks.map((task) => {
                      const latestRun = [...task.runs].reverse().find((r) => r.sessionId)
                      return (
                        <button
                          key={`task:${task.taskId}`}
                          type="button"
                          onClick={() => {
                            closeDialog()
                            if (latestRun?.sessionId) {
                              onOpenLinkedSession(latestRun.sessionId, task.workspace.cwd)
                            } else {
                              useBotStore.getState().openBot()
                              useBotStore.getState().setDrawerOpen(true, task.taskId)
                            }
                          }}
                          className={cn(pillButtonClass, 'h-6 max-w-64 px-2 text-[11px] text-muted-foreground hover:text-foreground')}
                        >
                          <Bot className="size-3 shrink-0" />
                          <span className="truncate">{t('kanban.linkedTask', { title: task.title })}</span>
                          <ArrowUpRight className="size-3 shrink-0" />
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>

              {/* Compact Linear property pills row (Status · Priority · Project · Labels) */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-5 pt-2 pb-3.5">
                {/* Status pill */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={pillButtonClass}>
                      <KanbanStatusIcon status={status} className="size-3.5" />
                      <span>{t(`kanban.status.${status}`)}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-40">
                    <DropdownMenuRadioGroup
                      value={status}
                      onValueChange={(next) => setStatus(next as KanbanStatus)}
                    >
                      {KANBAN_STATUSES.map((s) => (
                        <DropdownMenuRadioItem key={s} value={s}>
                          <KanbanStatusIcon status={s} className="size-3.5" />
                          <span>{t(`kanban.status.${s}`)}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Priority pill */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(pillButtonClass, priority === 'none' && 'text-muted-foreground')}
                    >
                      <KanbanPriorityIcon priority={priority} className="size-3.5" />
                      <span>
                        {priority === 'none'
                          ? t('kanban.fields.priority')
                          : t(`kanban.priority.${priority}`)}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-40">
                    <DropdownMenuRadioGroup
                      value={priority}
                      onValueChange={(next) => setPriority(next as KanbanPriority)}
                    >
                      {KANBAN_PRIORITIES.map((p) => (
                        <DropdownMenuRadioItem key={p} value={p}>
                          <KanbanPriorityIcon priority={p} className="size-3.5" />
                          <span>{t(`kanban.priority.${p}`)}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Project pill */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(pillButtonClass, 'max-w-48', !projectCwd && 'text-muted-foreground')}
                    >
                      <Box className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">
                        {selectedProjectName ?? t('kanban.fields.project')}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-48">
                    <DropdownMenuRadioGroup
                      value={projectCwd ?? ''}
                      onValueChange={(next) => setProjectCwd(next || null)}
                    >
                      <DropdownMenuRadioItem value="">
                        <Inbox className="size-3.5 text-muted-foreground" />
                        <span>{t('kanban.unassigned')}</span>
                      </DropdownMenuRadioItem>
                      {projectOptions.map((proj) => (
                        <DropdownMenuRadioItem key={proj.cwd} value={proj.cwd}>
                          <Box className="size-3.5 text-muted-foreground" />
                          <span className="truncate">{proj.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Unified single Labels pill (0 -> "标签", 1 -> "● Feature", N -> "●● N 个标签") */}
                <Popover open={labelMenuOpen} onOpenChange={setLabelMenuOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('kanban.fields.labels')}
                      title={labels.length > 1 ? labels.join(', ') : undefined}
                      className={cn(
                        pillButtonClass,
                        labels.length === 0 && 'text-muted-foreground'
                      )}
                    >
                      {labels.length === 0 ? (
                        <>
                          <Tag className="size-3.5" aria-hidden="true" />
                          <span>{t('kanban.fields.labels')}</span>
                        </>
                      ) : labels.length === 1 ? (
                        <>
                          <KanbanLabelDot label={labels[0]} className="size-2.5" />
                          <span className="max-w-36 truncate">{labels[0]}</span>
                        </>
                      ) : (
                        <>
                          <KanbanStackedLabelDots labels={labels} />
                          <span>{t('kanban.labelsCount', { count: labels.length })}</span>
                        </>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    className="w-56 p-1"
                    onCloseAutoFocus={(e) => e.preventDefault()}
                  >
                    <div className="border-b border-glass-border px-2.5 py-1.5 solid:border-border">
                      <input
                        type="text"
                        value={labelQuery}
                        onChange={(e) => setLabelQuery(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (isComposingKey(e.nativeEvent)) return
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            if (!exactLabelExists) createCustomLabel()
                            else if (filteredLabelOptions.length > 0) toggleLabel(filteredLabelOptions[0])
                          }
                        }}
                        placeholder={t('kanban.fields.labelsPlaceholder')}
                        className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/65"
                      />
                    </div>
                    <div className="max-h-52 overflow-y-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {filteredLabelOptions.map((option) => {
                        const checked = labels.some((l) => l.toLowerCase() === option.toLowerCase())
                        return (
                          <button
                            key={option}
                            type="button"
                            onClick={() => toggleLabel(option)}
                            className="flex h-7.5 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-foreground transition-colors hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent"
                          >
                            <KanbanLabelDot label={option} className="size-2.5" />
                            <span className="min-w-0 flex-1 truncate">{option}</span>
                            {checked ? (
                              <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                            ) : null}
                          </button>
                        )
                      })}
                      {!exactLabelExists && labelQuery.trim() ? (
                        <button
                          type="button"
                          onClick={createCustomLabel}
                          className="flex h-7.5 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-xs text-foreground transition-colors hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent"
                        >
                          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="shrink-0 text-muted-foreground">{t('kanban.createLabel')}</span>
                          <KanbanLabelDot label={labelQuery.trim()} className="ml-0.5 size-2.5" />
                          <span className="min-w-0 truncate font-medium">{labelQuery.trim()}</span>
                        </button>
                      ) : null}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </>
          )}

          {/* Clean Linear footer bar */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-glass-border px-5 py-3 solid:border-border">
            <div className="flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const picked = e.currentTarget.files ? [...e.currentTarget.files] : []
                  e.currentTarget.value = ''
                  if (picked.length > 0) void addImageFiles(picked)
                }}
              />
              {dialog?.mode === 'create' || existingIssue ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('kanban.attachImage')}
                      onClick={() => fileInputRef.current?.click()}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Paperclip className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('kanban.attachImage')}</TooltipContent>
                </Tooltip>
              ) : null}

              {dialog?.mode === 'edit' && existingIssue ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('kanban.delete')}
                      onClick={() => setConfirmDeleteOpen(true)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('kanban.delete')}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              {dialog?.mode === 'create' ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none hover:text-foreground">
                  <Switch size="sm" checked={createMore} onCheckedChange={setCreateMore} />
                  <span>{t('kanban.createMore')}</span>
                </label>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={closeDialog} disabled={saving}>
                  {t('common.cancel')}
                </Button>
              )}

              {dialog?.mode === 'create' || existingIssue ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={!title.trim() || saving}
                  className="rounded-full px-4"
                >
                  {t(dialog?.mode === 'create' ? 'kanban.create' : 'kanban.save')}
                </Button>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ImagePreview src={previewSrc} onClose={() => setPreviewSrc(null)} />

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('kanban.deleteConfirmTitle', { number: existingIssue?.number ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('kanban.deleteConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost" disabled={deleting}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleConfirmDelete()}
            >
              {t('kanban.deleteConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
