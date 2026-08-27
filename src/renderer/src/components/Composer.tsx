import { useCallback, useState } from 'react'
import { ArrowUp, Box, Brain, Square } from 'lucide-react'
import {
  api,
  type SessionContextUsage,
  type SessionTokenStats,
  type ThinkingLevel
} from '../ipc/api'
import { chatColumn } from '../chat/layout'
import { useSessionsStore } from '../stores/sessions'
import { cn } from '../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
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
import { Progress } from './ui/progress'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高'
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

export function Composer() {
  const [text, setText] = useState('')
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const refreshProject = useSessionsStore((s) => s.refreshProject)
  const applyControls = useSessionsStore((s) => s.applyControls)
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

  const changeModel = useCallback(
    async (value: string) => {
      if (!activeSessionId) return
      const [provider, ...rest] = value.split('::')
      const id = rest.join('::')
      if (!provider || !id) return
      applyControls(activeSessionId, await api.setModel(activeSessionId, provider, id))
    },
    [activeSessionId, applyControls]
  )

  const changeThinking = useCallback(
    async (value: string) => {
      if (!activeSessionId) return
      applyControls(activeSessionId, await api.setThinking(activeSessionId, value as ThinkingLevel))
    },
    [activeSessionId, applyControls]
  )

  const modelValue = model ? `${model.provider}::${model.id}` : ''
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <InputGroupButton className={cn(toolbarBtn, 'max-w-44')} disabled={!activeSessionId}>
                  <Box data-icon="inline-start" />
                  <span className="min-w-0 truncate">{model?.name ?? '模型'}</span>
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-auto min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuRadioGroup value={modelValue} onValueChange={(value) => void changeModel(value)}>
                    {models.map((item) => (
                      <DropdownMenuRadioItem key={`${item.provider}::${item.id}`} value={`${item.provider}::${item.id}`}>
                        {item.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <InputGroupButton
                  className={toolbarBtn}
                  disabled={!activeSessionId || thinkingLevels.length <= 1}
                >
                  <Brain data-icon="inline-start" />
                  {thinkingLabels[thinkingLevel]}
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-auto min-w-28">
                <DropdownMenuGroup>
                  <DropdownMenuRadioGroup value={thinkingLevel} onValueChange={(value) => void changeThinking(value)}>
                    {thinkingLevels.map((level) => (
                      <DropdownMenuRadioItem key={level} value={level}>
                        {thinkingLabels[level]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
