/**
 * Left-aligned Projects / Chats capsule switch pinned at the top of the left sidebar.
 * Mirrors WorkspacePanel's expanding active pill inside a subtle rounded-full container
 * whose top edge aligns flush with the center content card's 8px margin.
 */
import { useId } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { FolderKanban, MessageCircleMore, Plus } from 'lucide-react'
import type { SidebarTab } from '../../../../shared/api'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { sidebarButtonSurface } from './sidebar-surface'

export function SidebarModeSwitch({
  tab,
  onSelect,
  onNewChat,
  actionDisabled
}: {
  tab: SidebarTab
  onSelect: (next: SidebarTab) => void
  onNewChat: () => void
  actionDisabled: boolean
}) {
  const t = useT()
  const switchId = useId()
  const reduced = useReducedMotion()

  return (
    <header className="flex shrink-0 items-center justify-between gap-2 px-1 pt-2 pb-0.5 whitespace-nowrap">
      <ToggleGroup
        type="single"
        size="xs"
        spacing={1}
        value={tab}
        onValueChange={(value) => value && onSelect(value as SidebarTab)}
        aria-label={t('sidebar.tabsAria')}
        className="rounded-full border border-glass-border bg-glass-prompt-foreground/6 p-0.5 solid:border-sidebar-border solid:bg-transparent"
      >
        {(['projects', 'chats'] as const).map((mode) => {
          const active = mode === tab
          const Icon = mode === 'projects' ? FolderKanban : MessageCircleMore
          const label = t(mode === 'projects' ? 'sidebar.projects' : 'sidebar.chats')
          return (
            <ToggleGroupItem
              key={mode}
              value={mode}
              aria-label={label}
              title={label}
              className="relative gap-0 rounded-full px-2 font-normal data-[state=on]:bg-transparent! solid:data-[state=on]:bg-transparent! solid:data-[state=on]:text-sidebar-foreground"
            >
              {active ? (
                <motion.span
                  layoutId={switchId}
                  data-sidebar-mode-pill
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full border border-glass-button-border bg-glass-button-background bg-[image:var(--glass-button-sheen)] shadow-glass-button solid:border-border solid:bg-sidebar-accent solid:bg-none solid:shadow-none"
                  transition={reduced ? { duration: 0 } : { type: 'spring', visualDuration: 0.25, bounce: 0 }}
                />
              ) : null}
              <Icon className="relative" />
              <motion.span
                initial={false}
                animate={{ width: active ? 'auto' : 0, opacity: active ? 1 : 0 }}
                transition={{ duration: reduced ? 0 : 0.2, ease: 'easeInOut' }}
                className="relative overflow-hidden"
              >
                <span className="flex items-center gap-1.5 pl-1.5">{label}</span>
              </motion.span>
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>
      {tab === 'chats' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn('shrink-0 text-muted-foreground', sidebarButtonSurface)}
              aria-label={t('sidebar.newChat')}
              disabled={actionDisabled}
              onClick={onNewChat}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('sidebar.newChat')}</TooltipContent>
        </Tooltip>
      ) : null}
    </header>
  )
}
