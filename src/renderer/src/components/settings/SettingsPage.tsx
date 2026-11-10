import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Brain, ChevronLeft, Component, GamepadDirectional, Keyboard, Rainbow, ShieldCheck, Snowflake, Webhook } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { useSettingsStore } from '../../stores/settings'
import { cn } from '../../lib/utils'
import { isShortcutRecording } from '../../lib/shortcuts'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { sidebarRowSurface, sidebarSurfaceHover } from '../sidebar/sidebar-surface'
import { SidebarHoverHighlight } from '../sidebar/SidebarHoverHighlight'
import { GeneralPane } from './GeneralPane'
import { ThemePane } from './ThemePane'
import { ShortcutsPane, ShortcutsResetAll } from './ShortcutsPane'
import { ProvidersPane } from './ProvidersPane'
import { PluginsPane } from './PluginsPane'
import { PersonaMemoryPane } from './PersonaMemoryPane'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog'
import { McpPane } from './McpPane'
import { SkillsPane } from './SkillsPane'
import { PermissionsPane } from './PermissionsPane'

const sections = [
  {
    id: 'general',
    title: 'settings.sectionGeneral',
    description: 'settings.sectionGeneralDescription',
    icon: Snowflake,
    component: GeneralPane
  },
  {
    id: 'persona-memory',
    title: 'features.title',
    description: 'features.description',
    icon: Brain,
    component: PersonaMemoryPane
  },
  {
    id: 'shortcuts',
    title: 'shortcuts.title',
    description: 'shortcuts.description',
    icon: Keyboard,
    component: ShortcutsPane,
    action: ShortcutsResetAll
  },
  {
    id: 'theme',
    title: 'settings.sectionTheme',
    description: 'settings.sectionThemeDescription',
    icon: Rainbow,
    component: ThemePane
  },
  {
    id: 'providers',
    title: 'settings.sectionProviders',
    description: 'settings.sectionProvidersDescription',
    icon: GamepadDirectional,
    component: ProvidersPane
  },
  {
    id: 'mcp',
    title: 'mcp.title',
    description: 'mcp.description',
    icon: Webhook,
    component: McpPane
  },
  {
    id: 'skills',
    title: 'skills.title',
    description: 'skills.description',
    icon: BookOpen,
    component: SkillsPane
  },
  {
    id: 'plugins',
    title: 'settings.sectionPlugins',
    description: 'settings.sectionPluginsDescription',
    icon: Component,
    component: PluginsPane
  },
  {
    id: 'permissions',
    title: 'permissions.title',
    description: 'permissions.description',
    icon: ShieldCheck,
    component: PermissionsPane
  }
] as const

type SettingsSection = (typeof sections)[number]['id']

export function SettingsPage({ onClose, navigationTarget, active = true }: {
  onClose: () => void
  navigationTarget?: HTMLElement | null
  active?: boolean
}) {
  const t = useT()
  const [section, setSection] = useState<SettingsSection>('general')
  const [featureDirty, setFeatureDirty] = useState(false)
  const [featureBusy, setFeatureBusy] = useState(false)
  const [discardFeatures, setDiscardFeatures] = useState(false)
  const requestClose = () => {
    if (featureBusy) return
    if (featureDirty) setDiscardFeatures(true)
    else onClose()
  }
  const load = useSettingsStore((s) => s.load)
  const error = useSettingsStore((s) => s.error)
  const currentSection = sections.find((item) => item.id === section)!

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || isShortcutRecording()) return
      if (
        document.querySelector(
          '[data-slot=dialog-content], [data-slot=alert-dialog-content], [data-slot=popover-content][data-state=open], [data-slot=select-content][data-state=open], [data-slot=dropdown-menu-content][data-state=open]'
        )
      )
        return
      event.preventDefault()
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onClose, featureBusy, featureDirty])

  const navigation = (
    <nav className="flex h-full min-h-0 w-62 shrink-0 flex-col gap-1 px-2 py-2">
      <div className="flex h-8 shrink-0 items-center px-2.5 text-xs font-normal text-muted-foreground">
        {t('sidebar.settings')}
      </div>
      <ScrollArea className="-mx-1.5 -mt-1.5 min-h-0 flex-1">
        <SidebarHoverHighlight className="flex flex-col gap-1 p-1.5">
          {sections.map(({ id, title, description, icon: SectionIcon }) => {
            const active = section === id
            return (
              <Button
                key={id}
                type="button"
                variant="ghost"
                data-sidebar-hover-row
                data-sidebar-selected={active || undefined}
                className={cn(
                  'relative h-auto w-full items-start justify-start gap-2.5 px-2.5 py-2 text-left',
                  sidebarRowSurface(active),
                  active
                    ? 'text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:text-sidebar-accent-foreground'
                )}
                onClick={() => setSection(id)}
              >
                <SectionIcon className="mt-0.5 size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-normal leading-tight">{t(title)}</span>
                  <span className="text-xs font-normal text-muted-foreground leading-normal">
                    {t(description)}
                  </span>
                </span>
              </Button>
            )
          })}
        </SidebarHoverHighlight>
      </ScrollArea>
      <div className="pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('w-full justify-start text-muted-foreground hover:text-sidebar-accent-foreground', sidebarSurfaceHover)}
          disabled={featureBusy}
          onClick={requestClose}
        >
          <ChevronLeft data-icon="inline-start" />
          {t('settings.back')}
        </Button>
      </div>
    </nav>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {navigationTarget === undefined ? navigation : navigationTarget ? createPortal(navigation, navigationTarget) : null}
      <div
        data-app-surface
        data-settings-surface
        className="m-2 min-w-0 flex-1 overflow-hidden rounded-xl bg-glass-background shadow-glass-panel ring-1 ring-glass-border transition-[background-color,box-shadow] duration-200 ease-in-out motion-reduce:transition-none solid:bg-card solid:shadow-none solid:ring-0"
      >
        <ScrollArea className="h-full [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-base font-medium">{t(currentSection.title)}</h1>
                <p className="text-xs text-muted-foreground">{t(currentSection.description)}</p>
              </div>
              {'action' in currentSection ? <currentSection.action /> : null}
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {sections.map(({ id, component: Pane }) => (
              <div key={id} className={section === id ? 'contents' : 'hidden'}>
                {id === 'persona-memory'
                  ? <PersonaMemoryPane onDirtyChange={setFeatureDirty} onBusyChange={setFeatureBusy} />
                  : <Pane /> }
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
      <AlertDialog open={discardFeatures} onOpenChange={setDiscardFeatures}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('features.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('features.discardHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('persona.keepEditing')}</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>{t('persona.discard')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
