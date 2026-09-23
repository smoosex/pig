import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { FileText, Folder } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { PopoverContent } from '../ui/popover'
import type { FileMentions } from './useFileMentions'
import { baseName } from '../../../../shared/paths'

/** The `@` row list: a basename to scan, a muted relative path to disambiguate, a folder for a way in. */
export function MentionSuggestions({
  mentions,
  anchorRef
}: {
  mentions: FileMentions
  anchorRef: RefObject<HTMLDivElement | null>
}) {
  const selectedRef = useRef<HTMLButtonElement>(null)
  const [width, setWidth] = useState(0)
  const { open, items, index: selectedIndex } = mentions

  useEffect(() => {
    if (open) selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [open, selectedIndex, items])

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
        {items.map((item, index) => {
          const Icon = item.isDirectory ? Folder : FileText
          return (
            <Button
              key={item.path}
              ref={index === selectedIndex ? selectedRef : undefined}
              type="button"
              variant="ghost"
              className={cn(
                'h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-3 text-xs font-normal transition-none hover:bg-accent',
                index === selectedIndex && 'bg-accent'
              )}
              onMouseEnter={() => mentions.setIndex(index)}
              onClick={() => mentions.select(item)}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn('shrink-0 font-normal', index === selectedIndex && 'font-medium')}>
                {baseName(item.path)}{item.isDirectory ? '/' : null}
              </span>
              <span className="min-w-0 truncate font-normal text-muted-foreground">{item.path}</span>
            </Button>
          )
        })}
      </div>
    </PopoverContent>
  )
}
