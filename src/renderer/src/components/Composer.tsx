import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { ArrowUp, BookOpen, Box, RefreshCw, Square, X } from 'lucide-react'
import {
  api,
  type SessionContextUsage,
  type SessionModelInfo,
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
  InputGroupButton,
  InputGroupTextarea
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

function clipboardImages(event: ClipboardEvent): File[] {
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

export function Composer() {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PastedImage[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const selectedSlashRef = useRef<HTMLButtonElement>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const composing = useRef(false)
  const commandsFor = useRef<string | null>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const [slashWidth, setSlashWidth] = useState(0)
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const refreshCwd = useSessionsStore((s) => s.refreshCwd)
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.isStreaming ?? false) : false
  )
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

  useEffect(() => {
    commandsFor.current = null
    setCommands([])
    setSlashDismissed(false)
    return () => {
      setPreview(null)
      setImages((current) => {
        for (const image of current) URL.revokeObjectURL(image.url)
        return []
      })
    }
  }, [activeSessionId])

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

  useEffect(() => {
    if (!slashOpen) return
    selectedSlashRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [slashIndex, slashOpen, filtered])

  useLayoutEffect(() => {
    if (!slashOpen) return
    setSlashWidth(composerBoxRef.current?.offsetWidth ?? 0)
  }, [slashOpen])

  const applySlash = (command: SlashCommand) => {
    setText(`/${command.name} `)
    setSlashDismissed(true)
  }

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || isStreaming || !activeSessionId) return
    if (trimmed === '/export' || trimmed.startsWith('/export ')) {
      const result = await api.exportSession(activeSessionId, exportPathArg(trimmed))
      if (!result) return
      setText('')
      return
    }
    const prepared = await api.prepareSession(activeSessionId)
    if (prepared.created) await refreshCwd(prepared.cwd)
    const title = trimmed.slice(0, 500) || (images.length > 0 ? '图片' : '')
    if (title) useSessionsStore.getState().previewSessionTitle(activeSessionId, title)
    const payload = images.map(({ mimeType, data }) => ({ mimeType, data }))
    setText('')
    setPreview(null)
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.url)
      return []
    })
    await api.prompt(activeSessionId, trimmed, payload.length > 0 ? payload : undefined)
    await Promise.all([refreshCwd(prepared.cwd), useSessionsStore.getState().loadControls(activeSessionId)])
  }, [text, images, isStreaming, activeSessionId, refreshCwd])

  const abort = useCallback(async () => {
    if (!activeSessionId) return
    await api.abort(activeSessionId)
  }, [activeSessionId])

  const canSend = Boolean((text.trim() || images.length > 0) && activeSessionId && !isStreaming)

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
    <div className={cn(chatColumn, 'pb-3.5')}>
      <Popover
        open={slashOpen}
        onOpenChange={(open) => {
          if (!open) setSlashDismissed(true)
        }}
      >
      <PopoverAnchor asChild>
      <div ref={composerBoxRef} className="rounded-2xl shadow-md">
      <InputGroup
        data-streaming={isStreaming || undefined}
        className="composer-focus min-h-32 rounded-2xl bg-composer-background has-disabled:bg-composer-background has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-composer-background dark:has-disabled:bg-composer-background"
      >
        <InputGroupTextarea
          className="min-h-16 px-3.5 pt-3 text-sm leading-snug"
          value={text}
          placeholder={activeSessionId ? '输入一条消息...' : '请先选择会话'}
          rows={3}
          disabled={!activeSessionId}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            requestAnimationFrame(() => {
              composing.current = false
            })
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return
            if (slashOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((index) => (index + 1) % filtered.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((index) => (index - 1 + filtered.length) % filtered.length)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlashDismissed(true)
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                applySlash(filtered[slashIndex] ?? filtered[0])
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                applySlash(filtered[slashIndex] ?? filtered[0])
                return
              }
            }
            if (e.key !== 'Enter') return
            const sendNow = sendShortcut === 'enter' ? !e.shiftKey : e.shiftKey
            if (!sendNow) return
            e.preventDefault()
            void send()
          }}
          onPaste={(e) => {
            const files = clipboardImages(e)
            if (files.length === 0) return
            if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
            void Promise.all(files.map(readImage)).then((next) => {
              setImages((current) => [...current, ...next])
            })
          }}
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
        <InputGroupAddon align="block-end" className="justify-between px-2.5 pb-2.5">
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
            {isStreaming ? (
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
                aria-label="发送"
                disabled={!canSend}
                onClick={() => void send()}
              >
                <ArrowUp />
              </InputGroupButton>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
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
