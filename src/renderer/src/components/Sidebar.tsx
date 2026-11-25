import { Activity, useState } from 'react'
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
import { KanbanSidebar } from './kanban/KanbanSidebar'
import { useKanbanStore } from '../stores/kanban'
import { useProjectSpacesStore } from '../stores/project-spaces'
import { ChatList } from './sidebar/ChatList'
import { ProjectList } from './sidebar/ProjectList'
import { ProjectSpaceDialog } from './sidebar/ProjectSpaceDialog'
import { ProjectSpaceSwitcher, useProjectSpacesSync } from './sidebar/ProjectSpaceSwitcher'
import { useSpaceWheelSwipe } from './sidebar/use-space-swipe'
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
  useProjectSpacesSync()
  const handleSpaceSwipe = useSpaceWheelSwipe()
  // The right sidebar keeps its own preferences in the same file, so its failures belong on this same line.
  const reviewPrefsError = useDiffStore((s) => s.prefsError)
  const spacesError = useProjectSpacesStore((s) => (s.dialog ? null : s.error))
  const error = projectError ?? preferencesError ?? reviewPrefsError ?? spacesError ?? settingsError
  // Mount each sidebar list lazily on first visit, then retain it via Activity so switching
  // between Projects and Chats does not tear down and rebuild Radix/dnd-kit trees every time.
  const [mountedTabs, setMountedTabs] = useState<{ projects: boolean; chats: boolean; kanban: boolean }>(() => ({
    projects: tab === 'projects',
    chats: tab === 'chats',
    kanban: tab === 'kanban'
  }))
  if (!mountedTabs[tab]) {
    setMountedTabs((previous) => (previous[tab] ? previous : { ...previous, [tab]: true }))
  }

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
          onNewIssue={() => useKanbanStore.getState().openCreateDialog()}
          actionDisabled={projectPending !== null}
        />
        <ScrollArea
          onWheel={tab === 'projects' ? handleSpaceSwipe : undefined}
          className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden"
        >
          <SidebarHoverHighlight className="pt-1">
            {mountedTabs.projects ? (
              <Activity mode={tab === 'projects' ? 'visible' : 'hidden'}>
                <ProjectList />
              </Activity>
            ) : null}
            {mountedTabs.chats ? (
              <Activity mode={tab === 'chats' ? 'visible' : 'hidden'}>
                <ChatList />
              </Activity>
            ) : null}
            {mountedTabs.kanban ? (
              <Activity mode={tab === 'kanban' ? 'visible' : 'hidden'}>
                <KanbanSidebar />
              </Activity>
            ) : null}
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
          {mountedTabs.projects ? (
            <Activity mode={tab === 'projects' ? 'visible' : 'hidden'}>
              <ProjectSpaceSwitcher />
            </Activity>
          ) : null}
          {tab !== 'projects' ? <span className="flex-1" /> : null}
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
        <ProjectSpaceDialog />
      </div>
    </aside>
  )
}
