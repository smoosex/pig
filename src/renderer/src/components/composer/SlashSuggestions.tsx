import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { BookOpen } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { PopoverContent } from '../ui/popover'
import { slashGroups } from './commands'
import type { SlashCommands } from './useSlashCommands'

export function SlashSuggestions({
  commands,
  anchorRef
}: {
  commands: SlashCommands
  anchorRef: RefObject<HTMLDivElement | null>
}) {
  const selectedRef = useRef<HTMLButtonElement>(null)
  const [width, setWidth] = useState(0)
  const { open, filtered, index: selectedIndex } = commands

  useEffect(() => {
    if (open) selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [open, selectedIndex, filtered])

  useLayoutEffect(() => {
    if (open) setWidth(anchorRef.current?.offsetWidth ?? 0)
  }, [open, anchorRef])

  return (
    <PopoverContent
      align="start"
      side="top"
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      className="max-w-none gap-0.5 rounded-2xl p-1.5"
      style={width > 0 ? { width } : undefined}
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
              ref={index === selectedIndex ? selectedRef : undefined}
              type="button"
              variant="ghost"
              className={cn(
                'h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-3 text-xs font-normal transition-none hover:bg-accent',
                index === selectedIndex && 'bg-accent'
              )}
              onMouseEnter={() => commands.setIndex(index)}
              onClick={() => commands.select(command)}
            >
              {command.source === 'skill' ? <BookOpen className="text-chart-4" /> : null}
              <span className={cn('shrink-0 font-normal', index === selectedIndex && 'font-medium', command.source === 'skill' && 'text-chart-4')}>
                /{command.name}
              </span>
              {command.description ? <span className="min-w-0 truncate font-normal text-muted-foreground">{command.description}</span> : null}
            </Button>
          </Fragment>
        ))}
      </div>
    </PopoverContent>
  )
}
