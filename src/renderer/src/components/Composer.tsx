import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowUp, Box, RefreshCw, Square } from 'lucide-react'
import {
  api,
  type SessionContextUsage,
  type SessionModelInfo,
  type SessionTokenStats,
  type ThinkingLevel
} from '../ipc/api'
import { chatColumn } from '../chat/layout'
import { useSessionsStore } from '../stores/sessions'
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

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

const thinkingStrength: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5
}

function ThinkingStrengthIcon({
  level,
  active = false
}: {
  level: ThinkingLevel
  active?: boolean
}) {
  const filled = thinkingStrength[level]
  const heights = ['h-1', 'h-1.5', 'h-2', 'h-2.5', 'h-3']

  return (
    <span aria-hidden="true" className="inline-flex h-3 w-6 shrink-0 items-end gap-px">
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
          <ThinkingStrengthIcon level={thinkingLevel} active />
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
              <ThinkingStrengthIcon level={level} active={selected} />
              {thinkingLabels[level]}
            </Button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

export function Composer() {
  const [text, setText] = useState('')
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const refreshProject = useSessionsStore((s) => s.refreshProject)
  const runtime = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId] : undefined
  )
  const isStreaming = runtime?.isStreaming ?? false
  const model = runtime?.model ?? null
  const models = runtime?.models ?? []
  const thinkingLevel = runtime?.thinkingLevel ?? 'off'
  const thinkingLevels = runtime?.thinkingLevels ?? ['off']
  const contextUsage = runtime?.contextUsage ?? null
  const tokens = runtime?.tokens ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0
  }

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || !activeSessionId) return
    const prepared = await api.prepareSession(activeSessionId)
    if (prepared.created) await refreshProject(prepared.cwd)
    setText('')
    await api.prompt(activeSessionId, trimmed)
    await Promise.all([refreshProject(prepared.cwd), useSessionsStore.getState().loadControls(activeSessionId)])
  }, [text, isStreaming, activeSessionId, refreshProject])

  const abort = useCallback(async () => {
    if (!activeSessionId) return
    await api.abort(activeSessionId)
  }, [activeSessionId])

  const canSend = Boolean(text.trim() && activeSessionId && !isStreaming)

  return (
    <div className={cn(chatColumn, 'pb-5')}>
      <InputGroup
        data-streaming={isStreaming || undefined}
        className="composer-focus min-h-32 rounded-2xl bg-card has-disabled:bg-card has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-card dark:has-disabled:bg-card"
      >
        <InputGroupTextarea
          className="min-h-16 px-3.5 pt-3 text-sm leading-snug"
          value={text}
          placeholder={activeSessionId ? '输入一条消息...' : '请先选择会话'}
          rows={3}
          disabled={!activeSessionId}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
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
  )
}
