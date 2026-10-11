import { FolderPlus, Plus, Settings } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { useDiffStore } from '../stores/diff'
import type { SidebarTab } from '../../../shared/api'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { ChatList } from './sidebar/ChatList'
import { ProjectList } from './sidebar/ProjectList'
import { SidebarHoverHighlight } from './sidebar/SidebarHoverHighlight'
import { useProjectAction } from './sidebar/project-action'

export function Sidebar({
  onOpenSettings,
  hidden = false,
  tab,
  preferencesError
}: {
  onOpenSettings: () => void
  hidden?: boolean
  tab: SidebarTab
  preferencesError: string | null
}) {
  const openProject = useSessionsStore((s) => s.openProject)
  const newChat = useSessionsStore((s) => s.newChat)
  const t = useT()
  const {
    pending: projectPending,
    error: projectError,
    runAction: runProjectAction
  } = useProjectAction()
  // The right sidebar keeps its own preferences in the same file, so its failures belong on this same line.
  const reviewPrefsError = useDiffStore((s) => s.prefsError)
  const error = projectError ?? preferencesError ?? reviewPrefsError

  return (
    <aside
      inert={hidden}
      aria-hidden={hidden}
      className={cn(
        'flex min-w-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
        hidden ? 'w-0' : 'w-62'
      )}
    >
      <div className="flex w-62 shrink-0 flex-col pl-2">
        {tab === 'chats' ? (
          <div className="group/header flex h-8 shrink-0 items-center pr-1 pl-2">
            <span className="text-xs font-medium text-muted-foreground">{t('sidebar.chats')}</span>
            <div className="flex-1" />
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
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <SidebarHoverHighlight className="pt-1">
            {tab === 'projects' ? <ProjectList /> : <ChatList />}
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
