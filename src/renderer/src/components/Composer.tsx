import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BorderBeam } from '@smoose/border-beam'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Editor, JSONContent } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import {
  ArrowUp,
  BookOpen,
  Box,
  RefreshCw,
  Square,
  X
} from 'lucide-react'
import {
  createPastedTextFilename,
  isLongPastedText,
  stripPastedTextAttachments,
  utf8ByteLength,
  type PastedTextPromptAttachment
} from '../../../shared/pasted-text'
import {
  api,
  type SessionContextUsage,
  type SessionModelInfo,
  type PromptStreamingBehavior,
  type SessionTokenStats,
  type SlashCommand,
  type ThinkingLevel
} from '../ipc/api'
import { useModelNavigation } from '../hooks/useModelNavigation'
import { chatColumn } from '../chat/layout'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton
} from './ui/input-group'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from './ui/popover'
import { Input } from './ui/input'
import { Progress } from './ui/progress'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { SessionTreeButton } from './SessionTreeDialog'
import { ImagePreview } from './ImagePreview'
import { PastedTextNode } from './PastedTextNode'
import { FollowUpQueue } from './FollowUpQueue'

const EMPTY_MODELS: SessionModelInfo[] = []
const EMPTY_LEVELS: ThinkingLevel[] = ['off']
const EMPTY_TOKENS: SessionTokenStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0
}

const slashGroups = {
  builtin: { order: 0, label: '内建' },
  prompt: { order: 1, label: '模板' },
  extension: { order: 2, label: '扩展' },
  skill: { order: 3, label: 'Skills' }
}

function slashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  if (text.includes('\n')) return null
  const rest = text.slice(1)
  if (/\s/.test(rest)) return null
  return rest
}

function exportPathArg(text: string): string | undefined {
  if (text === '/export') return undefined
  if (!text.startsWith('/export ')) return undefined
  const rest = text.slice(8).trim()
  if (!rest) return undefined
  const quote = rest[0]
  if ((quote === '"' || quote === "'") && rest.endsWith(quote) && rest.length >= 2) {
    return rest.slice(1, -1)
  }
  return rest
}

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

const thinkingBarHeights: Record<3 | 4 | 5, string[]> = {
  3: ['h-1.5', 'h-2.5', 'h-3'],
  4: ['h-1.5', 'h-2', 'h-2.5', 'h-3'],
  5: ['h-1', 'h-1.5', 'h-2', 'h-2.5', 'h-3']
}

function ThinkingStrengthIcon({
  level,
  levels,
  active = false
}: {
  level: ThinkingLevel
  levels: ThinkingLevel[]
  active?: boolean
}) {
  const bars = levels.length === 4 || levels.length === 3 ? levels.length : 5
  const filled = Math.max(levels.indexOf(level) + 1, 0)
  const heights = thinkingBarHeights[bars]

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-3 shrink-0 items-end gap-px',
        bars === 5 ? 'w-6' : bars === 4 ? 'w-5' : 'w-4'
      )}
    >
      {heights.map((height, index) => (
        <span
          key={height}
          className={cn(
            'w-1 rounded-xs',
            height,
            index < filled
              ? active
                ? 'bg-primary'
                : 'bg-muted-foreground/40'
              : 'bg-muted-foreground/20'
          )}
        />
      ))}
    </span>
  )
}

const toolbarBtn =
  "h-6 rounded-full px-2 text-xs font-light [&_svg:not([class*='size-'])]:size-3"

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const scaled = value / 1000
    return `${scaled >= 100 && Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}k`
  }
  const scaled = value / 1_000_000
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`
}

function StatRow({
  label,
  value,
  muted = true
}: {
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className={cn('flex items-center justify-between text-xs', muted && 'text-muted-foreground')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

function ContextUsageButton({
  usage,
  tokens,
  disabled
}: {
  usage: SessionContextUsage | null
  tokens: SessionTokenStats
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const used = usage?.tokens ?? null
  const windowSize = usage?.contextWindow ?? 0
  const percent = usage?.percent ?? null
  const hover = '上下文用量'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <InputGroupButton
              className="size-8 rounded-full p-0 text-muted-foreground"
              aria-label="上下文窗口"
              disabled={disabled}
            >
              <ContextMeter percent={percent} />
            </InputGroupButton>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open ? <TooltipContent>{hover}</TooltipContent> : null}
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-72">
        <PopoverHeader>
          <PopoverTitle className="text-xs">上下文</PopoverTitle>
        </PopoverHeader>
        <div className="flex flex-col gap-2">
          <div className="text-sm tabular-nums">
            <span className="font-medium">{used == null ? '–' : formatTokens(used)}</span>
            <span className="text-muted-foreground">
              {' / '}{windowSize > 0 ? formatTokens(windowSize) : '–'}
            </span>
          </div>
          <Progress value={percent ?? 0} />
          <div className="flex flex-col gap-1.5">
            <StatRow label="快照" value={percent == null ? '–' : `${Math.round(percent)}%`} />
            <StatRow label="输入" value={formatTokens(tokens.input)} />
            <StatRow label="缓存读取" value={formatTokens(tokens.cacheRead)} />
            <StatRow label="缓存写入" value={formatTokens(tokens.cacheWrite)} />
            <StatRow label="输出" value={formatTokens(tokens.output)} />
          </div>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <StatRow label="总输入输出" value={formatTokens(tokens.total)} muted={false} />
            <StatRow label="有效输入" value={formatTokens(tokens.input + tokens.cacheRead)} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ContextMeter({ percent }: { percent: number | null }) {
  const value = Math.max(0, Math.min(100, percent ?? 0))
  const r = 11
  const c = 2 * Math.PI * r
  return (
    <span className="relative inline-flex size-8 items-center justify-center">
      <svg viewBox="0 0 32 32" className="size-8 -rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" className="stroke-border" strokeWidth="2.25" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          className="stroke-primary"
          strokeWidth="2.25"
          strokeDasharray={`${(value / 100) * c} ${c}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[9px] tabular-nums text-muted-foreground">
        {percent == null ? '–' : `${Math.round(value)}%`}
      </span>
    </span>
  )
}

function modelKey(item: SessionModelInfo): string {
  return `${item.provider}::${item.id}`
}

function ModelPicker({
  sessionId,
  model,
  models,
  disabled
}: {
  sessionId: string | null
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  disabled?: boolean
}) {
  const applyControls = useSessionsStore((s) => s.applyControls)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((item) =>
      `${item.name} ${item.providerName} ${item.provider} ${item.id}`.toLowerCase().includes(q)
    )
  }, [models, query])

  const select = async (item: SessionModelInfo) => {
    if (!sessionId) return
    applyControls(sessionId, await api.setModel(sessionId, item.provider, item.id))
    setOpen(false)
  }

  const navigation = useModelNavigation(filtered, open, (item) => { void select(item) })

  const refresh = async () => {
    if (!sessionId || refreshing) return
    setRefreshing(true)
    try {
      applyControls(sessionId, await api.refreshModels(sessionId))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <InputGroupButton className={cn(toolbarBtn, 'max-w-44')} disabled={disabled}>
          <Box data-icon="inline-start" />
          <span className="min-w-0 truncate">{model?.name ?? '模型'}</span>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-1 rounded-2xl p-1.5" onKeyDown={navigation.onKeyDown}>
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={query}
            placeholder="搜索模型"
            className="h-7 md:text-xs"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="刷新模型列表"
            disabled={!sessionId || refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          </Button>
        </div>
        <div
          className="max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {models.length === 0 ? '没有可用模型' : '没有匹配的模型'}
            </p>
          ) : (
            filtered.map((item, index) => {
              const key = modelKey(item)
              const selected = model?.provider === item.provider && model.id === item.id
              return (
                <Button
                  key={key}
                  type="button"
                  variant="ghost"
                  data-model={key}
                  ref={navigation.index === index ? navigation.activeRef : undefined}
                  onPointerMove={() => navigation.hover(index)}
                  aria-current={selected || undefined}
                  className={cn(
                    'h-auto w-full items-baseline justify-start gap-3 whitespace-normal rounded-lg px-3 py-2 transition-none hover:bg-accent dark:hover:bg-accent',
                    navigation.index === index && 'bg-accent'
                  )}
                  onClick={() => void select(item)}
                >
                  <span className="w-6 shrink-0 text-left text-xs tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {item.providerName} · {item.provider}/{item.id}
                    </span>
                  </span>
                </Button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ThinkingPicker({
  sessionId,
  thinkingLevel,
  thinkingLevels,
  disabled
}: {
  sessionId: string | null
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  disabled?: boolean
}) {
  const applyControls = useSessionsStore((s) => s.applyControls)
  const [open, setOpen] = useState(false)

  const select = async (level: ThinkingLevel) => {
    if (!sessionId) return
    applyControls(sessionId, await api.setThinking(sessionId, level))
    setOpen(false)
  }
  const contentRef = useRef<HTMLDivElement>(null)
  const navigation = useModelNavigation(thinkingLevels, open, (level) => { void select(level) })

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
    >
      <PopoverTrigger asChild>
        <InputGroupButton className={toolbarBtn} disabled={disabled}>
          <ThinkingStrengthIcon level={thinkingLevel} levels={thinkingLevels} active />
          {thinkingLabels[thinkingLevel]}
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        tabIndex={-1}
        align="start"
        side="top"
        className="w-auto min-w-44 gap-0.5 rounded-2xl p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          contentRef.current?.focus()
        }}
        onKeyDown={navigation.onKeyDown}
      >
        <p className="px-3 py-1.5 text-xs text-muted-foreground">推理强度</p>
        {thinkingLevels.map((level, index) => {
          const selected = level === thinkingLevel
          return (
            <Button
              key={level}
              type="button"
              variant="ghost"
              className={cn(
                'h-8 w-full justify-start gap-3 rounded-lg px-3 font-normal transition-none hover:bg-accent dark:hover:bg-accent',
                navigation.index === index && 'bg-accent'
              )}
              ref={navigation.index === index ? navigation.activeRef : undefined}
              onPointerMove={() => navigation.hover(index)}
              onClick={() => void select(level)}
            >
              <span className="w-4 shrink-0 text-left text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <ThinkingStrengthIcon level={level} levels={thinkingLevels} active={selected} />
              {thinkingLabels[level]}
            </Button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

type PastedImage = {
  id: string
  mimeType: string
  data: string
  url: string
}

function clipboardImages(event: Pick<ClipboardEvent, 'clipboardData'>): File[] {
  const data = event.clipboardData
  if (!data) return []
  if (data.files.length > 0) {
    return [...data.files].filter((file) => file.type.startsWith('image/'))
  }
  const files: File[] = []
  for (const item of data.items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

function readImage(file: File): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Failed to read image'))
        return
      }
      const comma = result.indexOf(',')
      resolve({
        id: crypto.randomUUID(),
        mimeType: file.type || 'image/png',
        data: comma === -1 ? result : result.slice(comma + 1),
        url: URL.createObjectURL(file)
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

type SerializedComposer = {
  text: string
  attachments: PastedTextPromptAttachment[]
}

function serializeComposer(editor: Editor | null): SerializedComposer {
  if (!editor) return { text: '', attachments: [] }
  const json = editor.getJSON()
  let text = ''
  const attachments: PastedTextPromptAttachment[] = []

  const append = (node: JSONContent) => {
    if (node.type === 'text') {
      text += node.text ?? ''
      return
    }
    if (node.type === 'hardBreak') {
      text += '\\n'
      return
    }
    if (node.type === 'pastedText') {
      const attrs = node.attrs ?? {}
      const pastedText = String(attrs.text ?? '')
      const start = text.length
      text += pastedText
      attachments.push({
        id: String(attrs.id ?? crypto.randomUUID()),
        text: pastedText,
        byteSize: Number(attrs.byteSize) || utf8ByteLength(pastedText),
        start,
        end: text.length,
        ...(attrs.filename ? { filename: String(attrs.filename) } : {})
      })
      return
    }
    for (const child of node.content ?? []) append(child)
  }

  for (const [index, node] of (json.content ?? []).entries()) {
    if (index > 0) text += '\\n'
    append(node)
  }
  return { text, attachments }
}

export function Composer() {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PastedImage[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const selectedSlashRef = useRef<HTMLButtonElement>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [steerHintMounted, setSteerHintMounted] = useState(false)
  const [steerHintLeaving, setSteerHintLeaving] = useState(false)
  const composing = useRef(false)
  const sendRef = useRef<(behavior?: PromptStreamingBehavior) => void>(() => undefined)
  const streamingRef = useRef(false)
  const hasDraftRef = useRef(false)
  const applySlashRef = useRef<(command: SlashCommand) => void>(() => undefined)
  const slashStateRef = useRef({ open: false, filtered: [] as SlashCommand[], index: 0 })
  const commandsFor = useRef<string | null>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const [slashWidth, setSlashWidth] = useState(0)
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const sendShortcutRef = useRef(sendShortcut)
  sendShortcutRef.current = sendShortcut
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: '⌘L to focus chat' }),
      PastedTextNode
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: ({ editor: nextEditor }) => setText(serializeComposer(nextEditor).text),
    editorProps: {
      attributes: {
        'data-slot': 'input-group-control',
        'aria-label': '消息',
        'aria-multiline': 'true',
        class: 'min-h-16 outline-none whitespace-pre-wrap break-words'
      },
      handleDOMEvents: {
        compositionstart: () => {
          composing.current = true
          return false
        },
        compositionend: () => {
          requestAnimationFrame(() => {
            composing.current = false
          })
          return false
        }
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || composing.current || event.keyCode === 229) return false
        const slash = slashStateRef.current
        if (slash.open) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSlashIndex((index) => (index + 1) % slash.filtered.length)
            return true
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSlashIndex((index) => (index - 1 + slash.filtered.length) % slash.filtered.length)
            return true
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setSlashDismissed(true)
            return true
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault()
            applySlashRef.current(slash.filtered[slash.index] ?? slash.filtered[0])
            return true
          }
        }
        if (
          event.key === 'Tab' &&
          !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey &&
          streamingRef.current && hasDraftRef.current
        ) {
          event.preventDefault()
          sendRef.current('steer')
          return true
        }
        if (event.key !== 'Enter') return false
        const sendNow = sendShortcutRef.current === 'enter' ? !event.shiftKey : event.shiftKey
        if (!sendNow) return false
        event.preventDefault()
        sendRef.current()
        return true
      },
      handlePaste: (view, event) => {
        const pastedText = event.clipboardData?.getData('text/plain') ?? ''
        const files = clipboardImages(event)
        const longText = isLongPastedText(pastedText)
        if (longText) {
          event.preventDefault()
          const node = view.state.schema.nodes.pastedText.create({
            id: crypto.randomUUID(),
            text: pastedText,
            byteSize: utf8ByteLength(pastedText),
            filename: createPastedTextFilename()
          })
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
        }
        if (files.length > 0) {
          if (!pastedText) event.preventDefault()
          void Promise.all(files.map(readImage)).then((next) => {
            setImages((current) => [...current, ...next])
          })
        }
        return longText || (!pastedText && files.length > 0)
      }
    }
  })
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const queuedEditText = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.queuedEditText ?? null) : null
  )
  const clearQueuedEditText = useSessionsStore((s) => s.clearQueuedEditText)
  const refreshCwd = useSessionsStore((s) => s.refreshCwd)
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.isStreaming ?? false) : false
  )
  useEffect(() => {
    if (appearance !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [appearance])
  const currentTheme = appearance === 'dark'
    ? darkTheme
    : appearance === 'light'
      ? lightTheme
      : systemDark
        ? darkTheme
        : lightTheme
  const borderBeamVariant = currentTheme === 'everforest' ? 'forest' : 'colorful'
  const model = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.model ?? null) : null
  )
  const models = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.models ?? EMPTY_MODELS) : EMPTY_MODELS
  )
  const thinkingLevel = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.thinkingLevel ?? 'off') : 'off'
  )
  const thinkingLevels = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.thinkingLevels ?? EMPTY_LEVELS) : EMPTY_LEVELS
  )
  const contextUsage = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.contextUsage ?? null) : null
  )
  const tokens = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.tokens ?? EMPTY_TOKENS) : EMPTY_TOKENS
  )
  const serialized = serializeComposer(editor)
  const hasDraft = Boolean(serialized.text.trim() || serialized.attachments.length > 0 || images.length > 0)
  streamingRef.current = isStreaming
  hasDraftRef.current = hasDraft

  useEffect(() => {
    commandsFor.current = null
    setCommands([])
    setSlashDismissed(false)
    editor?.commands.clearContent(true)
    setText('')
    return () => {
      setPreview(null)
      setImages((current) => {
        for (const image of current) URL.revokeObjectURL(image.url)
        return []
      })
    }
  }, [activeSessionId, editor])

  useEffect(() => {
    editor?.setEditable(Boolean(activeSessionId))
  }, [activeSessionId, editor])

  useEffect(() => {
    if (!editor || !activeSessionId || queuedEditText == null) return
    const content = queuedEditText.split('\n').map((line) =>
      line.length > 0
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' }
    )
    editor.commands.setContent({ type: 'doc', content })
    clearQueuedEditText(activeSessionId)
    editor.commands.focus()
  }, [activeSessionId, clearQueuedEditText, editor, queuedEditText])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'l' ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.defaultPrevented
      ) return
      event.preventDefault()
      if (!event.repeat) editor?.commands.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])

  const query = slashQuery(text)

  useEffect(() => {
    setSlashDismissed(false)
  }, [text])

  useEffect(() => {
    if (!activeSessionId || query === null) return
    if (commandsFor.current === activeSessionId) return
    const sessionId = activeSessionId
    commandsFor.current = sessionId
    void api.getCommands(sessionId).then(
      (list) => {
        if (commandsFor.current === sessionId) setCommands(list)
      },
      () => {
        if (commandsFor.current === sessionId) {
          commandsFor.current = null
          setCommands([])
        }
      }
    )
  }, [activeSessionId, query])

  const filtered = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    return commands
      .filter((command) => command.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aHit = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bHit = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return slashGroups[a.source].order - slashGroups[b.source].order || aHit - bHit || a.name.localeCompare(b.name)
      })
  }, [commands, query])

  useEffect(() => {
    setSlashIndex(0)
  }, [query, commands])

  const slashOpen = query !== null && !slashDismissed && filtered.length > 0
  const showSteerHint = isStreaming && hasDraft && !slashOpen

  useEffect(() => {
    if (showSteerHint) {
      setSteerHintMounted(true)
      setSteerHintLeaving(false)
      return
    }
    if (!steerHintMounted) return
    setSteerHintLeaving(true)
    const timeout = window.setTimeout(() => {
      setSteerHintMounted(false)
      setSteerHintLeaving(false)
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [showSteerHint, steerHintMounted])

  useEffect(() => {
    slashStateRef.current = { open: slashOpen, filtered, index: slashIndex }
  }, [slashOpen, filtered, slashIndex])

  useEffect(() => {
    if (!slashOpen) return
    selectedSlashRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [slashIndex, slashOpen, filtered])

  useLayoutEffect(() => {
    if (!slashOpen) return
    setSlashWidth(composerBoxRef.current?.offsetWidth ?? 0)
  }, [slashOpen])

  const applySlash = (command: SlashCommand) => {
    editor?.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `/${command.name} ` }] }]
    }, { emitUpdate: false })
    editor?.commands.focus('end')
    setText(`/${command.name} `)
    setSlashDismissed(true)
  }
  applySlashRef.current = applySlash

  const send = useCallback(async (streamingBehavior: PromptStreamingBehavior = 'followUp') => {
    const hasAttachments = serialized.attachments.length > 0
    const trimmed = serialized.text.trim()
    if ((!trimmed && !hasAttachments && images.length === 0) || !activeSessionId) return
    if (!isStreaming && (trimmed === '/export' || trimmed.startsWith('/export ')) && !hasAttachments) {
      const result = await api.exportSession(activeSessionId, exportPathArg(trimmed))
      if (!result) return
      editor?.commands.clearContent(false)
      return
    }
    const prepared = await api.prepareSession(activeSessionId)
    if (prepared.created) await refreshCwd(prepared.cwd)
    const titleText = hasAttachments
      ? stripPastedTextAttachments(serialized.text, serialized.attachments).trim()
      : trimmed
    const title = titleText.slice(0, 500) || (hasAttachments ? 'Pasted text' : images.length > 0 ? '图片' : '')
    if (title) useSessionsStore.getState().previewSessionTitle(activeSessionId, title)
    const payload = images.map(({ mimeType, data }) => ({ mimeType, data }))
    editor?.commands.clearContent(false)
    setText('')
    setPreview(null)
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.url)
      return []
    })
    await api.prompt(
      activeSessionId,
      hasAttachments ? serialized.text : trimmed,
      payload.length > 0 ? payload : undefined,
      hasAttachments ? serialized.attachments : undefined,
      isStreaming ? streamingBehavior : undefined
    )
    await Promise.all([refreshCwd(prepared.cwd), useSessionsStore.getState().loadControls(activeSessionId)])
  }, [editor, images, isStreaming, activeSessionId, refreshCwd, serialized])
  sendRef.current = (behavior) => { void send(behavior) }

  const abort = useCallback(async () => {
    if (!activeSessionId) return
    await api.abort(activeSessionId)
  }, [activeSessionId])

  const canSend = Boolean(hasDraft && activeSessionId)

  const removeImage = (id: string) => {
    setImages((current) => {
      const next = current.filter((image) => image.id !== id)
      const removed = current.find((image) => image.id === id)
      if (removed) {
        URL.revokeObjectURL(removed.url)
        if (preview === removed.url) setPreview(null)
      }
      return next
    })
  }

  return (
    <div className={cn(chatColumn, 'relative isolate shrink-0 pb-3.5')}>
      <FollowUpQueue key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
      <Popover
        open={slashOpen}
        onOpenChange={(open) => {
          if (!open) setSlashDismissed(true)
        }}
      >
      <PopoverAnchor asChild>
      <div ref={composerBoxRef} className="relative rounded-2xl shadow-md">
      {steerHintMounted ? (
        <div className={cn(
          'pointer-events-none absolute right-3 bottom-full z-0 rounded-t-md bg-primary px-2 py-0.5 text-xs text-primary-foreground shadow-sm',
          steerHintLeaving ? 'steer-hint-exit' : 'steer-hint-enter'
        )}>
          Tab 转为引导
        </div>
      ) : null}
      <div className="relative z-10">
      <BorderBeam
        size="md"
        colorVariant={borderBeamVariant}
        theme={appearance === 'system' ? 'auto' : appearance}
        active={focused || isStreaming}
        className="w-full"
      >
      <InputGroup
        className="min-h-[min(8rem,calc(100dvh-6rem))] max-h-[min(16rem,calc(100dvh-6rem))] overflow-hidden rounded-2xl border-[0.5px] border-border bg-composer-background has-disabled:bg-composer-background has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:border-border has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-composer-background dark:has-disabled:bg-composer-background"
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          setFocused(false)
        }}
      >
        <div className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <EditorContent
          editor={editor}
          className="min-h-16 w-full shrink-0 px-3.5 pt-3 text-sm leading-snug [&_.ProseMirror]:min-h-16 [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:m-0 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror:focus_.is-editor-empty:first-child::before]:hidden"
        />
        {images.length > 0 ? (
          <div className="flex w-full flex-wrap justify-start gap-1.5 px-3.5 pb-1.5">
            {images.map((image) => (
              <div key={image.id} className="relative shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  className="block h-auto rounded-md p-0 hover:bg-transparent"
                  aria-label="预览图片"
                  onClick={() => setPreview(image.url)}
                >
                  <img
                    src={image.url}
                    alt=""
                    className="h-10 max-w-16 cursor-pointer rounded-md object-cover"
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-0.5 right-0.5 size-3.5 rounded-full bg-black/65 p-0 text-white hover:bg-black/80 hover:text-white"
                  aria-label="移除图片"
                  onClick={() => removeImage(image.id)}
                >
                  <X className="size-2" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        </div>
        <InputGroupAddon align="block-end" className="shrink-0 justify-between px-2.5 pb-2.5">
          <div className="flex min-w-0 items-center gap-1">
            <ModelPicker
              sessionId={activeSessionId}
              model={model}
              models={models}
              disabled={!activeSessionId}
            />
            <ThinkingPicker
              sessionId={activeSessionId}
              thinkingLevel={thinkingLevel}
              thinkingLevels={thinkingLevels}
              disabled={!activeSessionId || thinkingLevels.length <= 1}
            />
            <SessionTreeButton disabled={!activeSessionId || isStreaming} />
          </div>
          <div className="flex items-center gap-1.5">
            <ContextUsageButton
              usage={contextUsage}
              tokens={tokens}
              disabled={!activeSessionId}
            />
            {isStreaming && !hasDraft ? (
              <InputGroupButton
                size="icon-sm"
                variant="secondary"
                className="size-7 rounded-full [&_svg]:fill-current [&_svg:not([class*='size-'])]:size-2.5"
                aria-label="暂停"
                onClick={() => void abort()}
              >
                <Square />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                size="icon-sm"
                variant="default"
                className="size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5"
                aria-label={isStreaming ? '跟进' : '发送'}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <ArrowUp />
              </InputGroupButton>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
      </BorderBeam>
      </div>
      </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="top"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="max-w-none gap-0.5 rounded-2xl p-1.5"
        style={slashWidth > 0 ? { width: slashWidth } : undefined}
      >
        <div className="max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filtered.map((command, index) => (
            <Fragment key={`${command.source}:${command.name}`}>
            {index === 0 || filtered[index - 1].source !== command.source ? (
              <div className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground">
                {slashGroups[command.source].label}
              </div>
            ) : null}
            <Button
              ref={index === slashIndex ? selectedSlashRef : undefined}
              type="button"
              variant="ghost"
              className={cn(
                'h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-3 text-xs font-normal transition-none hover:bg-accent dark:hover:bg-accent',
                index === slashIndex && 'bg-accent hover:bg-accent'
              )}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => applySlash(command)}
            >
              {command.source === 'skill' ? <BookOpen className="text-chart-4" /> : null}
              <span className={cn('shrink-0 font-normal', index === slashIndex && 'font-medium', command.source === 'skill' && 'text-chart-4')}>/{command.name}</span>
              {command.description ? (
                <span className="min-w-0 truncate font-normal text-muted-foreground">{command.description}</span>
              ) : null}
            </Button>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
      </Popover>
      <ImagePreview src={preview} onClose={() => setPreview(null)} />
    </div>
  )
}
