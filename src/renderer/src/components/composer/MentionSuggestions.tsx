import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Folder, Globe, MessageSquare, Terminal } from 'lucide-react'
import { FileTypeIcon } from '../files/FileTypeIcon'
import { KanbanStatusIcon } from '../kanban/kanban-icons'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { PopoverContent } from '../ui/popover'
import type { FileMentions, MentionItem } from './useFileMentions'
import { issueMentionLabel } from './issue-mentions'
import { tabMentionLabel } from './tab-mentions'
import { baseName } from '../../../../shared/paths'
import { useT } from '../../hooks/useT'

const GROUP_LABELS = {
  issue: 'fileMention.groupIssue',
  session: 'fileMention.groupSession',
  browser: 'fileMention.groupBrowser',
  terminal: 'fileMention.groupTerminal',
  file: 'fileMention.groupFile'
} as const

function itemGroup(item: MentionItem): keyof typeof GROUP_LABELS {
  if (item.kind === 'file') return 'file'
  if (item.kind === 'issue') return 'issue'
  return item.tab.kind
}

/** The `@` row list: a basename to scan, a muted relative path to disambiguate, a folder for a way in. */
export function MentionSuggestions({
  mentions,
  anchorRef
}: {
  mentions: FileMentions
  anchorRef: RefObject<HTMLDivElement | null>
}) {
  const t = useT()
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
          const group = itemGroup(item)
          const previous = items[index - 1]
          const startsGroup = !previous || itemGroup(previous) !== group
          const key =
            item.kind === 'file'
              ? `file:${item.file.path}`
              : item.kind === 'issue'
                ? `issue:${item.issue.number}`
                : `${item.tab.kind}:${item.tab.id}`
          return (
            <Fragment key={key}>
              {startsGroup ? (
                <div className={cn('px-3 pb-1 text-xs text-muted-foreground', index > 0 ? 'pt-2' : 'pt-1')}>{t(GROUP_LABELS[group])}</div>
              ) : null}
              <Button
                ref={index === selectedIndex ? selectedRef : undefined}
                type="button"
                variant="ghost"
                className={cn(
                  'h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-3 text-xs font-normal transition-none hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent',
                  index === selectedIndex && 'bg-glass-prompt-foreground/8 solid:bg-accent'
                )}
                onMouseEnter={() => mentions.setIndex(index)}
                onClick={() => mentions.select(item)}
              >
                {item.kind === 'file' ? (
                  item.file.isDirectory ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> :
                    <FileTypeIcon path={item.file.path} className="size-3.5 shrink-0 text-muted-foreground" />
                ) : item.kind === 'issue' ? (
                  <KanbanStatusIcon status={item.issue.status} className="size-3.5" />
                ) : item.tab.kind === 'browser' ? <Globe className="size-3.5 shrink-0 text-muted-foreground" /> :
                  item.tab.kind === 'terminal' ? <Terminal className="size-3.5 shrink-0 text-muted-foreground" /> :
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className={cn('shrink-0 font-normal', item.kind === 'issue' && 'max-w-72 truncate', index === selectedIndex && 'font-medium')}>
                  {item.kind === 'file'
                    ? <>{baseName(item.file.path)}{item.file.isDirectory ? '/' : null}</>
                    : item.kind === 'issue'
                      ? issueMentionLabel(item.issue)
                      : tabMentionLabel(item.tab)}
                </span>
                <span className="min-w-0 truncate font-normal text-muted-foreground">
                  {item.kind === 'file' ? item.file.path : item.kind === 'issue' ? item.issue.detail : item.tab.detail}
                </span>
              </Button>
            </Fragment>
          )
        })}
      </div>
    </PopoverContent>
  )
}
