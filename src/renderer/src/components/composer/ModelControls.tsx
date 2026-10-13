import { useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, type SessionModelInfo, type ThinkingLevel } from '../../ipc/api'
import { useModelNavigation } from '../../hooks/useModelNavigation'
import { thinkingLevelKeys } from '../../lib/thinking-levels'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { InputGroupButton } from '../ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'
import { ModelBrandIcon } from './ModelBrandIcon'
import type { ModelControlActions } from './useModelControls'

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
  const t = useT()
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

  // The switch applies to the next request, not to the turn already streaming: say so, since the
  // toolbar alone gives no sign that the running turn keeps its previous model.
  const select = async (item: SessionModelInfo) => {
    if (model?.provider === item.provider && model.id === item.id) {
      setOpen(false)
      return
    }
    if (sessionId && await actions.run(() => api.setModel(sessionId, item.provider, item.id))) {
      setOpen(false)
      toast.success(t('model.switched', { name: item.name }), { description: t('model.appliesNextRequest') })
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
        <InputGroupButton
          className={cn(toolbarBtn, 'max-w-44')}
          disabled={disabled}
          aria-label={model?.name ?? t('model.pickerFallback')}
          title={model?.name ?? t('model.pickerFallback')}
        >
          <ModelBrandIcon model={model} />
          <span className="hidden min-w-0 truncate @min-md/composer:block">{model?.name ?? t('model.pickerFallback')}</span>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-1 rounded-2xl p-1.5" onKeyDown={navigation.onKeyDown}>
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={query}
            placeholder={t('model.search')}
            className="h-7 md:text-xs"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('model.refresh')}
            disabled={!sessionId || actions.pending}
            onClick={() => void refresh()}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          </Button>
        </div>
        {actions.error ? <p role="alert" className="px-3 py-1.5 text-xs text-destructive">{actions.error}</p> : null}
        <div className="max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SmoothHoverHighlight activeKey={navigation.index}>
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {models.length === 0 ? t('model.empty') : t('model.noMatch')}
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
                  data-hover-highlight-row
                  data-hover-highlight-active={navigation.index === index ? '' : undefined}
                  ref={navigation.index === index ? navigation.activeRef : undefined}
                  onPointerMove={() => navigation.hover(index)}
                  aria-current={selected || undefined}
                  disabled={actions.pending}
                  className="relative h-auto w-full items-baseline justify-start gap-3 whitespace-normal rounded-lg px-3 py-2 transition-none hover:bg-transparent!"
                  onClick={() => void select(item)}
                >
                  <span className="w-6 shrink-0 text-left text-xs tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-xs font-normal">{item.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {item.providerName} · {item.provider}/{item.id}
                    </span>
                  </span>
                  </Button>
                )
              })
            )}
          </SmoothHoverHighlight>
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
  const t = useT()
  const [open, setOpen] = useState(false)

  const select = async (level: ThinkingLevel) => {
    if (level === thinkingLevel) {
      setOpen(false)
      return
    }
    if (sessionId && await actions.run(() => api.setThinking(sessionId, level))) {
      setOpen(false)
      toast.success(t('model.thinkingSwitched', { level: t(thinkingLevelKeys[level]) }), {
        description: t('model.appliesNextRequest')
      })
    }
  }
  const contentRef = useRef<HTMLDivElement>(null)
  const navigation = useModelNavigation(thinkingLevels, open, (level) => { void select(level) })

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
    >
      <PopoverTrigger asChild>
        <InputGroupButton
          className={toolbarBtn}
          disabled={disabled}
          aria-label={t(thinkingLevelKeys[thinkingLevel])}
          title={t(thinkingLevelKeys[thinkingLevel])}
        >
          <ThinkingStrengthIcon level={thinkingLevel} levels={thinkingLevels} active />
          <span className="hidden @min-md/composer:inline">{t(thinkingLevelKeys[thinkingLevel])}</span>
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
        <p className="px-3 py-1.5 text-xs text-muted-foreground">{t('model.thinking')}</p>
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
              {t(thinkingLevelKeys[level])}
            </Button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
