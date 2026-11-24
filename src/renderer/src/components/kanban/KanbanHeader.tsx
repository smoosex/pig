/**
 * Minimalist top-right Kanban controls rendered in `data-header-trailing` while the center titlebar stays clear:
 * 1. On-demand expandable search (`🔍` icon -> smooth pill input on click or `⌘F`; collapses on empty blur / `Esc`)
 * 2. Single-icon Board / List view toggle
 * 3. `+` New issue button
 */
import { useEffect, useRef, useState } from 'react'
import { Columns3, List, Plus, Search, X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { isComposingKey, isShortcutRecording, matchesShortcut } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useKanbanStore } from '../../stores/kanban'
import { ShortcutKbd } from '../ShortcutKbd'
import { sidebarSurfaceHover } from '../sidebar/sidebar-surface'
import { Button } from '../ui/button'
import { inputSurface } from '../ui/input-surface'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function KanbanHeader() {
  const t = useT()
  const viewMode = useKanbanStore((s) => s.viewMode)
  const setViewMode = useKanbanStore((s) => s.setViewMode)
  const searchQuery = useKanbanStore((s) => s.searchQuery)
  const setSearchQuery = useKanbanStore((s) => s.setSearchQuery)
  const openCreateDialog = useKanbanStore((s) => s.openCreateDialog)
  const dialogOpen = useKanbanStore((s) => s.dialog !== null)

  const [searchOpen, setSearchOpen] = useState(() => Boolean(searchQuery))
  const inputRef = useRef<HTMLInputElement>(null)
  const expanded = searchOpen || Boolean(searchQuery)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOpen || isShortcutRecording() || isComposingKey(event)) return
      if (matchesShortcut(event, 'kanban.search')) {
        event.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen])

  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const closeSearch = () => {
    setSearchQuery('')
    setSearchOpen(false)
  }

  const nextViewLabel = t(viewMode === 'board' ? 'kanban.switchToList' : 'kanban.switchToBoard')

  return (
    <>
      {expanded ? (
        <div
          className={cn(
            'no-drag flex h-7 w-48 translate-y-px items-center rounded-full border px-2.5 text-xs transition-[width] duration-150 ease-out motion-reduce:transition-none',
            inputSurface
          )}
        >
          <Search className="mr-1.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            onBlur={() => {
              if (!searchQuery.trim()) setSearchOpen(false)
            }}
            onKeyDown={(e) => {
              if (isComposingKey(e.nativeEvent)) return
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeSearch()
                inputRef.current?.blur()
              }
            }}
            placeholder={t('kanban.searchPlaceholder')}
            aria-label={t('kanban.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-glass-prompt-foreground/65 solid:placeholder:text-muted-foreground"
          />
          <button
            type="button"
            aria-label={t('bot.actions.dismiss')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeSearch}
            className="ml-1 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('kanban.searchIssues')}
              onClick={openSearch}
              className={cn('no-drag translate-y-px', sidebarSurfaceHover)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('kanban.searchIssues')} <ShortcutKbd action="kanban.search" />
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={nextViewLabel}
            onClick={() => setViewMode(viewMode === 'board' ? 'list' : 'board')}
            className={cn('no-drag translate-y-px', sidebarSurfaceHover)}
          >
            {viewMode === 'board' ? <List /> : <Columns3 />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{nextViewLabel}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('kanban.newIssue')}
            onClick={() => openCreateDialog()}
            className={cn('no-drag translate-y-px', sidebarSurfaceHover)}
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('kanban.newIssue')} <ShortcutKbd action="tab.new" />
        </TooltipContent>
      </Tooltip>
    </>
  )
}
