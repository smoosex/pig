/** One menu for a configured model and its thinking level: searchable models above, the level bar pinned below. */
import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Slider as SliderPrimitive } from 'radix-ui'
import type { SessionModelInfo, ThinkingLevel } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { thinkingLevelKeys } from '../../lib/thinking-levels'
import { modelKey } from '../../stores/settings'
import { useModelNavigation } from '../../hooks/useModelNavigation'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Separator } from '../ui/separator'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'
import { Switch } from '../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/** The level to keep after switching models: unsupported levels become unset. */
export function supportedThinking(model: SessionModelInfo, level: ThinkingLevel | null): ThinkingLevel | null {
  return level && model.thinkingLevels.includes(level) ? level : null
}

export function ModelThinkingPicker({
  model,
  models,
  label,
  thinking,
  onModelChange,
  onThinkingChange,
  defaultOption
}: {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  /** Shown for a configured model that is missing from the catalog. */
  label?: string
  thinking: ThinkingLevel | null
  onModelChange: (model: SessionModelInfo) => void
  onThinkingChange: (level: ThinkingLevel) => void
  /**
   * A 默认 toggle meaning "this caller chooses for you". While on, models and levels are locked;
   * turning it off only unlocks the menu, the caller stays on its default until a model is picked.
   */
  defaultOption?: { active: boolean; description: string; onSelect: () => void }
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const locked = !!defaultOption?.active && !unlocked
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((item) =>
      `${item.name} ${item.providerName} ${item.provider} ${item.id}`.toLowerCase().includes(q)
    )
  }, [models, query])
  const navigation = useModelNavigation(locked ? [] : filtered, open, onModelChange)
  const levels = model?.thinkingLevels ?? []
  const name = defaultOption?.active ? t('model.default') : model?.name ?? label ?? t('model.select')

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
          setUnlocked(false)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="max-w-64 font-normal">
          <span className="truncate">{name}</span>
          {!defaultOption?.active && thinking ? (
            <span className="shrink-0 text-muted-foreground">{t(thinkingLevelKeys[thinking])}</span>
          ) : null}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="max-h-[min(28rem,var(--radix-popover-content-available-height))] w-80 gap-1 p-1.5"
        onKeyDown={navigation.onKeyDown}
        // A locked menu has a disabled search box, so Radix would focus the 默认 switch and pop its tooltip.
        onOpenAutoFocus={(event) => { if (locked) event.preventDefault() }}
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <Input
            autoFocus
            aria-label={t('model.search')}
            value={query}
            disabled={locked}
            placeholder={t('model.search')}
            className="h-7 md:text-xs"
            onChange={(e) => setQuery(e.target.value)}
          />
          {defaultOption ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground">
                  {t('model.default')}
                  <Switch
                    size="sm"
                    aria-label={t('model.default')}
                    checked={locked}
                    onCheckedChange={(checked) => {
                      setUnlocked(!checked)
                      if (checked) defaultOption.onSelect()
                    }}
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent>{defaultOption.description}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div
          aria-disabled={locked || undefined}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            locked && 'pointer-events-none opacity-50'
          )}
        >
          <SmoothHoverHighlight activeKey={navigation.index} highlightClassName="bg-glass-prompt-foreground/8 solid:bg-accent">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {models.length === 0 ? t('model.empty') : t('model.noMatch')}
              </p>
            ) : (
              filtered.map((item, index) => (
                <Button
                  key={modelKey(item)}
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  data-hover-highlight-row
                  data-hover-highlight-active={navigation.index === index ? '' : undefined}
                  ref={navigation.index === index ? navigation.activeRef : undefined}
                  className="relative h-auto w-full justify-start px-2 py-2 text-left font-normal hover:bg-transparent! hover:text-glass-prompt-foreground! solid:hover:text-accent-foreground!"
                  onPointerMove={() => navigation.hover(index)}
                  onClick={() => onModelChange(item)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs">{item.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.providerName} · {item.provider}/{item.id}
                    </span>
                  </span>
                  {model && modelKey(model) === modelKey(item) ? <Check /> : null}
                </Button>
              ))
            )}
          </SmoothHoverHighlight>
        </div>
        <Separator className="my-0.5 shrink-0" />
        <div className="flex shrink-0 items-center justify-between gap-2 px-1 py-0.5">
          <span className="shrink-0 text-xs text-muted-foreground">{t('model.thinking')}</span>
          {locked || !model ? (
            <span className="py-1 text-xs text-muted-foreground">
              {locked ? t('model.default') : label ? t('model.unavailable') : t('model.chooseModelFirst')}
            </span>
          ) : levels.length === 0 ? (
            <span className="py-1 text-xs text-muted-foreground">{t('model.thinkingUnsupported')}</span>
          ) : (
            <ThinkingSlider levels={levels} value={thinking} onChange={onThinkingChange} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Half the thumb width: Radix keeps the thumb in bounds, so stop centres sit on a track inset by this much. */
const THUMB_INSET = '0.5rem'

/** Stepped level slider: drag, click a segment, use the arrows or the keyboard. Higher segments fill deeper. */
function ThinkingSlider({
  levels,
  value,
  onChange
}: {
  levels: ThinkingLevel[]
  value: ThinkingLevel | null
  onChange: (level: ThinkingLevel) => void
}) {
  const t = useT()
  const committed = value ? levels.indexOf(value) : -1
  const [dragging, setDragging] = useState<number | null>(null)
  // Radix only commits a changed value, so a click on the first stop while unset would otherwise do nothing.
  const moved = useRef(false)
  const index = dragging ?? committed
  const last = levels.length - 1
  const step = (next: number) => {
    const level = levels[next]
    if (level) onChange(level)
  }
  const label = index >= 0 ? t(thinkingLevelKeys[levels[index]]) : t('model.thinkingUnset')

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Button type="button" variant="ghost" size="icon-xs" aria-label={t('model.thinkingDown')}
        disabled={index <= 0} onClick={() => step(index - 1)}><ChevronLeft /></Button>
      {last > 0 ? (
        <SliderPrimitive.Root
          min={0}
          max={last}
          step={1}
          value={[Math.max(index, 0)]}
          aria-label={t('model.thinking')}
          className="relative flex h-5 min-w-0 flex-1 touch-none items-center select-none"
          onPointerDown={() => { moved.current = false }}
          onPointerUp={() => { if (!moved.current && committed < 0) step(0) }}
          onValueChange={([next]) => {
            moved.current = true
            setDragging(next)
          }}
          onValueCommit={([next]) => {
            setDragging(null)
            step(next)
          }}
        >
          <SliderPrimitive.Track className="relative h-1.5 grow">
            {levels.slice(1).map((level, segment) => (
              <span
                key={level}
                className={cn(
                  'absolute inset-y-0 rounded-full transition-colors',
                  segment >= index && 'bg-glass-prompt-foreground/10 solid:bg-primary/15'
                )}
                style={{
                  left: `calc(${THUMB_INSET} + (100% - 2 * ${THUMB_INSET}) * ${segment / last} + 1px)`,
                  width: `calc((100% - 2 * ${THUMB_INSET}) / ${last} - 2px)`,
                  backgroundColor: segment < index
                    ? `color-mix(in srgb, var(--primary) ${Math.round(40 + 60 * (segment + 1) / last)}%, transparent)`
                    : undefined
                }}
              />
            ))}
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-valuetext={label}
            className={cn(
              'block size-4 rounded-full border-[3px] border-primary bg-background shadow-sm outline-none transition-[opacity,scale] focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring',
              index < 0 && 'scale-75 border-muted-foreground opacity-60'
            )}
          />
        </SliderPrimitive.Root>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <Button type="button" variant="ghost" size="icon-xs" aria-label={t('model.thinkingUp')}
        disabled={index >= last} onClick={() => step(index + 1)}><ChevronRight /></Button>
      <span className={cn('w-10 shrink-0 text-right text-xs font-medium', index >= 0 ? 'text-primary' : 'text-muted-foreground')}>
        {label}
      </span>
    </div>
  )
}
