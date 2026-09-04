import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { ArrowUp, Box, RefreshCw, Square, X } from 'lucide-react'
import {
  api,
  type SessionContextUsage,
  type SessionModelInfo,
  type SessionTokenStats,
  type ThinkingLevel
} from '../ipc/api'
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
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const EMPTY_MODELS: SessionModelInfo[] = []
const EMPTY_LEVELS: ThinkingLevel[] = ['off']
const EMPTY_TOKENS: SessionTokenStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0
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
  const [hovered, setHovered] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const pointer = useRef({ x: 0, y: 0 })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((item) =>
      `${item.name} ${item.providerName} ${item.provider} ${item.id}`.toLowerCase().includes(q)
    )
  }, [models, query])

  const syncHover = () => {
    const node = document.elementFromPoint(pointer.current.x, pointer.current.y)?.closest('[data-model]')
    setHovered(node instanceof HTMLElement ? (node.dataset.model ?? null) : null)
  }

  const select = async (item: SessionModelInfo) => {
    if (!sessionId) return
    applyControls(sessionId, await api.setModel(sessionId, item.provider, item.id))
    setOpen(false)
  }

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
          setHovered(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <InputGroupButton className={cn(toolbarBtn, 'max-w-44')} disabled={disabled}>
          <Box data-icon="inline-start" />
          <span className="min-w-0 truncate">{model?.name ?? '模型'}</span>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-1 rounded-2xl p-1.5">
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
          onPointerMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY }
            syncHover()
          }}
          onPointerLeave={() => setHovered(null)}
          onScroll={syncHover}
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
                  className={cn(
                    'h-auto w-full items-start justify-start gap-3 whitespace-normal rounded-lg px-3 py-2 transition-none hover:bg-transparent',
                    (selected || hovered === key) && 'bg-muted hover:bg-muted'
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
  const [hovered, setHovered] = useState<string | null>(null)

  const select = async (level: ThinkingLevel) => {
    if (!sessionId) return
    applyControls(sessionId, await api.setThinking(sessionId, level))
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setHovered(null)
      }}
    >
      <PopoverTrigger asChild>
        <InputGroupButton className={toolbarBtn} disabled={disabled}>
          <ThinkingStrengthIcon level={thinkingLevel} levels={thinkingLevels} active />
          {thinkingLabels[thinkingLevel]}
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto min-w-44 gap-0.5 rounded-2xl p-1.5">
        <p className="px-3 py-1.5 text-xs text-muted-foreground">推理强度</p>
        {thinkingLevels.map((level, index) => {
          const selected = level === thinkingLevel
          return (
            <Button
              key={level}
              type="button"
              variant="ghost"
              className={cn(
                'h-8 w-full justify-start gap-3 rounded-lg px-3 font-normal transition-none hover:bg-transparent',
                (selected || hovered === level) && 'bg-muted hover:bg-muted'
              )}
              onPointerEnter={() => setHovered(level)}
              onPointerLeave={() => setHovered(null)}
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
  const composing = useRef(false)
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
    return () => {
      setPreview(null)
      setImages((current) => {
        for (const image of current) URL.revokeObjectURL(image.url)
        return []
      })
    }
  }, [activeSessionId])

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || isStreaming || !activeSessionId) return
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
    <div className={cn(chatColumn, 'pb-5')}>
      <div className="rounded-2xl shadow-md">
      <InputGroup
        data-streaming={isStreaming || undefined}
        className="composer-focus min-h-32 rounded-2xl bg-input has-disabled:bg-input has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-input dark:has-disabled:bg-input"
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
                <button
                  type="button"
                  className="block"
                  aria-label="预览图片"
                  onClick={() => setPreview(image.url)}
                >
                  <img
                    src={image.url}
                    alt=""
                    className="h-10 max-w-16 cursor-pointer rounded-md object-cover"
                  />
                </button>
                <button
                  type="button"
                  className="absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-black/65 text-white"
                  aria-label="移除图片"
                  onClick={() => removeImage(image.id)}
                >
                  <X className="size-2" />
                </button>
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
      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null) }}>
        <DialogContent
          showCloseButton
          className="w-fit max-w-[min(90vw,72rem)] border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-[min(90vw,72rem)]"
        >
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          {preview ? (
            <img src={preview} alt="" className="max-h-[85vh] max-w-full rounded-lg object-contain" />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
