import { FolderPlus, Plus, Settings } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { useDiffStore } from '../stores/diff'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { ChatList } from './sidebar/ChatList'
import { ProjectList } from './sidebar/ProjectList'
import { SectionHeader } from './sidebar/SectionHeader'
import { SidebarHoverHighlight } from './sidebar/SidebarHoverHighlight'
import { useProjectAction } from './sidebar/project-action'
import { useSidebarPreferences } from './sidebar/use-sidebar-preferences'

export function Sidebar({
  onOpenSettings,
  hidden = false
}: {
  onOpenSettings: () => void
  hidden?: boolean
}) {
  const openProject = useSessionsStore((s) => s.openProject)
  const newChat = useSessionsStore((s) => s.newChat)
  const t = useT()
  const {
    pending: projectPending,
    error: projectError,
    runAction: runProjectAction
  } = useProjectAction()
  const { collapsed, setSectionCollapsed, error: preferencesError } = useSidebarPreferences()
  // The right sidebar keeps its own preferences in the same file, so its failures belong on this same line.
  const reviewPrefsError = useDiffStore((s) => s.prefsError)
  const error = projectError ?? preferencesError ?? reviewPrefsError

  return (
    <aside
      inert={hidden}
      aria-hidden={hidden}
      className={cn(
        'flex min-w-0 shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
        hidden ? 'w-0' : 'w-62'
      )}
    >
      <div className="flex w-62 shrink-0 flex-col pl-2">
        <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <SidebarHoverHighlight className="pt-1">
            <Collapsible
              open={!collapsed.projects}
              onOpenChange={(open) => setSectionCollapsed('projects', !open)}
            >
              <SectionHeader
                className="top-0"
                label={t('sidebar.projects')}
                collapsed={collapsed.projects}
                onToggle={() => setSectionCollapsed('projects', !collapsed.projects)}
              />
              <CollapsibleContent>
                <ProjectList />
              </CollapsibleContent>
            </Collapsible>
            <Collapsible
              open={!collapsed.chats}
              onOpenChange={(open) => setSectionCollapsed('chats', !open)}
            >
              <SectionHeader
                className="top-8"
                label={t('sidebar.chats')}
                collapsed={collapsed.chats}
                onToggle={() => setSectionCollapsed('chats', !collapsed.chats)}
                action={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="pointer-events-none opacity-0 transition-opacity group-hover/header:pointer-events-auto group-hover/header:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 !bg-transparent"
                    aria-label={t('sidebar.newChat')}
                    disabled={projectPending !== null}
                    onClick={() => void runProjectAction('new-chat', newChat)}
                  >
                    <Plus />
                  </Button>
                }
              />
              <CollapsibleContent>
                <ChatList />
              </CollapsibleContent>
            </Collapsible>
          </SidebarHoverHighlight>
        </ScrollArea>
        {error && (
          <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">
            {error}
          </p>
        )}
        <div className="flex shrink-0 items-center gap-0.5 px-1 pb-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
                aria-label={t('sidebar.settings')}
                onClick={onOpenSettings}
              >
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('sidebar.settings')} <Kbd className="bg-transparent!">⌘ ,</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
                aria-label={t('app.openProject')}
                disabled={projectPending !== null}
                aria-busy={projectPending !== null}
                onClick={() => void runProjectAction('open-project', openProject)}
              >
                <FolderPlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('sidebar.addProject')} <Kbd className="bg-transparent!">⌘ ⇧ A</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  )
}
