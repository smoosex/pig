import { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { SessionModelInfo } from '../../ipc/api'
import { modelKey } from '../../stores/settings'
import { useModelNavigation } from '../../hooks/useModelNavigation'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'

export function DefaultModelPicker({
  model,
  models,
  onSelect
}: {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  onSelect: (model: SessionModelInfo) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((item) =>
      `${item.name} ${item.providerName} ${item.provider} ${item.id}`.toLowerCase().includes(q)
    )
  }, [models, query])
  const select = (item: SessionModelInfo) => {
    onSelect(item)
    setOpen(false)
    setQuery('')
  }
  const navigation = useModelNavigation(filtered, open, select)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="max-w-64 font-normal">
          <span className="truncate">{model?.name ?? '选择模型'}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-1 p-1.5" onKeyDown={navigation.onKeyDown}>
        <Input
          autoFocus
          aria-label="搜索模型"
          value={query}
          placeholder="搜索模型"
          className="h-7 shrink-0 md:text-xs"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-80 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SmoothHoverHighlight activeKey={navigation.index}>
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {models.length === 0 ? '没有可用模型' : '没有匹配的模型'}
              </p>
            ) : (
              filtered.map((item, index) => (
                <Button
                key={modelKey(item)}
                type="button"
                variant="ghost"
                data-hover-highlight-row
                data-hover-highlight-active={navigation.index === index ? '' : undefined}
                ref={navigation.index === index ? navigation.activeRef : undefined}
                className="relative h-auto w-full justify-start px-2 py-2 text-left font-normal hover:bg-transparent! hover:text-accent-foreground!"
                onPointerMove={() => navigation.hover(index)}
                onClick={() => select(item)}
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
      </PopoverContent>
    </Popover>
  )
}
