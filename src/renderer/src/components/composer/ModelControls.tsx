import { useMemo, useRef, useState } from 'react'
import { Box, RefreshCw } from 'lucide-react'
import { api, type SessionModelInfo, type ThinkingLevel } from '../../ipc/api'
import { useModelNavigation } from '../../hooks/useModelNavigation'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { InputGroupButton } from '../ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { ModelControlActions } from './useModelControls'

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

function modelKey(item: SessionModelInfo): string {
  return `${item.provider}::${item.id}`
}

export function ModelPicker({
  sessionId,
  model,
  models,
  actions,
  disabled
}: {
  sessionId: string | null
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  actions: ModelControlActions
  disabled?: boolean
}) {
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
    if (sessionId && await actions.run(() => api.setModel(sessionId, item.provider, item.id))) {
      setOpen(false)
    }
  }

  const navigation = useModelNavigation(filtered, open, (item) => { void select(item) })

  const refresh = async () => {
    if (!sessionId || actions.pending) return
    setRefreshing(true)
    try {
      await actions.run(() => api.refreshModels(sessionId))
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
            disabled={!sessionId || actions.pending}
            onClick={() => void refresh()}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          </Button>
        </div>
        {actions.error ? <p role="alert" className="px-3 py-1.5 text-xs text-destructive">{actions.error}</p> : null}
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
                  disabled={actions.pending}
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

export function ThinkingPicker({
  sessionId,
  thinkingLevel,
  thinkingLevels,
  actions,
  disabled
}: {
  sessionId: string | null
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  actions: ModelControlActions
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)

  const select = async (level: ThinkingLevel) => {
    if (sessionId && await actions.run(() => api.setThinking(sessionId, level))) setOpen(false)
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
        {actions.error ? <p role="alert" className="px-3 py-1.5 text-xs text-destructive">{actions.error}</p> : null}
        {thinkingLevels.map((level, index) => {
          const selected = level === thinkingLevel
          return (
            <Button
              key={level}
              type="button"
              variant="ghost"
              disabled={actions.pending}
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
