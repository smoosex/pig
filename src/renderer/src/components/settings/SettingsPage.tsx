import { useEffect, useState } from 'react'
import { ChevronLeft, Component, GamepadDirectional, Rainbow, Snowflake, Webhook } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { useSettingsStore } from '../../stores/settings'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { SidebarHoverHighlight } from '../sidebar/SidebarHoverHighlight'
import { GeneralPane } from './GeneralPane'
import { ThemePane } from './ThemePane'
import { ProvidersPane } from './ProvidersPane'
import { PluginsPane } from './PluginsPane'
import { McpPane } from './McpPane'

const sections = [
  {
    id: 'general',
    title: 'settings.sectionGeneral',
    description: 'settings.sectionGeneralDescription',
    icon: Snowflake,
    component: GeneralPane
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
    id: 'plugins',
    title: 'settings.sectionPlugins',
    description: 'settings.sectionPluginsDescription',
    icon: Component,
    component: PluginsPane
  }
] as const

type SettingsSection = (typeof sections)[number]['id']

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [section, setSection] = useState<SettingsSection>('general')
  const load = useSettingsStore((s) => s.load)
  const error = useSettingsStore((s) => s.error)
  const currentSection = sections.find((item) => item.id === section)!

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (
        document.querySelector(
          '[data-slot=dialog-content], [data-slot=alert-dialog-content], [data-slot=popover-content][data-state=open], [data-slot=select-content][data-state=open], [data-slot=dropdown-menu-content][data-state=open]'
        )
      )
        return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex min-h-0 w-62 shrink-0 flex-col gap-1 px-2 py-2">
        <div className="flex h-8 shrink-0 items-center px-2.5 text-xs font-normal text-muted-foreground">
          {t('sidebar.settings')}
        </div>
        <ScrollArea className="-mx-1.5 -mt-1.5 min-h-0 flex-1">
          <SidebarHoverHighlight activeKey={section} className="flex flex-col gap-1 p-1.5">
            {sections.map(({ id, title, description, icon: SectionIcon }) => {
              const active = section === id
              return (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  data-sidebar-hover-row
                  data-hover-highlight-active={active ? '' : undefined}
                  className={cn(
                    'relative h-auto w-full items-start justify-start gap-2.5 px-2.5 py-2 text-left hover:bg-transparent!',
                    active
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
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
            className="w-full justify-start text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={onClose}
          >
            <ChevronLeft data-icon="inline-start" />
            {t('settings.back')}
          </Button>
        </div>
      </nav>
      <div className="m-2 min-w-0 flex-1 overflow-hidden rounded-xl bg-card">
        <ScrollArea className="h-full [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-8">
            <div>
              <h1 className="text-base font-medium">{t(currentSection.title)}</h1>
              <p className="text-xs text-muted-foreground">{t(currentSection.description)}</p>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {sections.map(({ id, component: Pane }) => (
              <div key={id} className={section === id ? 'contents' : 'hidden'}>
                <Pane />
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
