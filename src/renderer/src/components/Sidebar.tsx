import { FolderPlus, Settings } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { useDiffStore } from '../stores/diff'
import { useSettingsStore } from '../stores/settings'
import type { SidebarTab } from '../../../shared/api'
import { Button } from './ui/button'
import { ShortcutKbd } from './ShortcutKbd'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { ChatList } from './sidebar/ChatList'
import { ProjectList } from './sidebar/ProjectList'
import { SidebarHoverHighlight } from './sidebar/SidebarHoverHighlight'
import { sidebarSurfaceHover } from './sidebar/sidebar-surface'
import { SidebarModeSwitch } from './sidebar/SidebarModeSwitch'
import { SurfaceStyleToggle } from './sidebar/SurfaceStyleToggle'
import { DreamStatusButton } from './sidebar/DreamStatus'
import { useProjectAction } from './sidebar/project-action'

export function Sidebar({
  onOpenSettings,
  hidden = false,
  floating = false,
  tab,
  onSwitchTab = () => {},
  preferencesError
}: {
  onOpenSettings: () => void
  hidden?: boolean
  floating?: boolean
  tab: SidebarTab
  onSwitchTab?: (next: SidebarTab) => void
  preferencesError: string | null
}) {
  const openProject = useSessionsStore((s) => s.openProject)
  const newChat = useSessionsStore((s) => s.newChat)
  const surfaceStyle = useSettingsStore((s) => s.surfaceStyle)
  const supportsGlass = useSettingsStore((s) => s.supportsGlass)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const settingsError = useSettingsStore((s) => s.error)
  const t = useT()
  const {
    pending: projectPending,
    error: projectError,
    runAction: runProjectAction
  } = useProjectAction()
  // The right sidebar keeps its own preferences in the same file, so its failures belong on this same line.
  const reviewPrefsError = useDiffStore((s) => s.prefsError)
  const error = projectError ?? preferencesError ?? reviewPrefsError ?? settingsError

  return (
    <aside
      inert={hidden}
      aria-hidden={hidden}
      className={cn(
        'flex min-w-0 overflow-hidden bg-transparent solid:bg-sidebar text-sidebar-foreground duration-200 ease-in-out motion-reduce:transition-none',
        floating && hidden ? 'transition-[background-color]' : 'transition-[width,background-color]',
        hidden ? 'w-0' : 'w-62'
      )}
    >
      <div className="flex w-62 shrink-0 flex-col pl-2">
        <SidebarModeSwitch
          tab={tab}
          onSelect={onSwitchTab}
          onNewChat={() => void runProjectAction('new-chat', newChat)}
          actionDisabled={projectPending !== null}
        />
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
                className={cn('text-muted-foreground', sidebarSurfaceHover)}
                aria-label={t('sidebar.settings')}
                onClick={onOpenSettings}
              >
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('sidebar.settings')} <ShortcutKbd action="settings.toggle" />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('text-muted-foreground', sidebarSurfaceHover)}
                aria-label={t('app.openProject')}
                disabled={projectPending !== null}
                aria-busy={projectPending !== null}
                onClick={() => void runProjectAction('open-project', openProject)}
              >
                <FolderPlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('sidebar.addProject')} <ShortcutKbd action="project.add" />
            </TooltipContent>
          </Tooltip>
          <span className="flex-1" />
          <DreamStatusButton />
          {supportsGlass ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <SurfaceStyleToggle
                  value={surfaceStyle}
                  onChange={(value) => void setTheme({ surfaceStyle: value })}
                  aria-label={t('sidebar.surfaceStyle')}
                />
              </TooltipTrigger>
              <TooltipContent>{t('sidebar.surfaceStyle')} · {surfaceStyle}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
