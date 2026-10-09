import { useEffect, useState } from 'react'
import {
  Cable,
  ChevronDown,
  ChevronLeft,
  Folder,
  KeyRound,
  Palette,
  Puzzle,
  Settings2
} from 'lucide-react'
import { useT } from '../../hooks/useT'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { GeneralPane } from './GeneralPane'
import { ThemePane } from './ThemePane'
import { ProvidersPane } from './ProvidersPane'
import { PluginsPane } from './PluginsPane'
import { McpPane } from './McpPane'
import { ProjectSettingsPane } from './ProjectSettingsPane'
import { useSessionsStore } from '../../stores/sessions'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { cn } from '../../lib/utils'

const sections = [
  {
    id: 'general',
    title: 'settings.sectionGeneral',
    description: 'settings.sectionGeneralDescription',
    icon: Settings2,
    component: GeneralPane
  },
  {
    id: 'theme',
    title: 'settings.sectionTheme',
    description: 'settings.sectionThemeDescription',
    icon: Palette,
    component: ThemePane
  },
  {
    id: 'providers',
    title: 'settings.sectionProviders',
    description: 'settings.sectionProvidersDescription',
    icon: KeyRound,
    component: ProvidersPane
  },
  {
    id: 'mcp',
    title: 'mcp.title',
    description: 'mcp.description',
    icon: Cable,
    component: McpPane
  },
  {
    id: 'plugins',
    title: 'settings.sectionPlugins',
    description: 'settings.sectionPluginsDescription',
    icon: Puzzle,
    component: PluginsPane
  }
] as const

type SettingsSection = (typeof sections)[number]['id'] | `project:${string}`

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [section, setSection] = useState<SettingsSection>('general')
  const [projectsOpen, setProjectsOpen] = useState(true)
  const projects = useSessionsStore((s) => s.projects)
  const project = projects.find((item) => section === `project:${item.cwd}`)
  const load = useSettingsStore((s) => s.load)
  const error = useSettingsStore((s) => s.error)
  const currentSection =
    sections.find((item) => item.id === section) ?? sections.find((item) => item.id === 'general')!
  const Icon = project ? Folder : currentSection.icon
  useEffect(() => {
    if (section.startsWith('project:') && !project) setSection('general')
  }, [section, project])

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
      <nav className="flex min-h-0 w-62 shrink-0 flex-col gap-1 px-2">
        <div className="flex items-center gap-2 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <ChevronLeft data-icon="inline-start" />
            {t('settings.back')}
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={onClose}>
            esc
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1">
            {sections.map(({ id, title, icon: SectionIcon }) => (
              <Button
                key={id}
                type="button"
                variant={section === id ? 'secondary' : 'ghost'}
                className="w-full justify-start"
                onClick={() => setSection(id)}
              >
                <SectionIcon data-icon="inline-start" />
                {t(title)}
              </Button>
            ))}
            <Collapsible open={projectsOpen} onOpenChange={setProjectsOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="w-full justify-start font-normal">
                  <Folder data-icon="inline-start" />
                  {t('mcp.projects')}
                  <ChevronDown
                    data-icon="inline-end"
                    className={cn('ml-auto', projectsOpen && 'rotate-180')}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-1">
                {projects.map((item) => (
                  <Button
                    key={item.cwd}
                    type="button"
                    variant={section === `project:${item.cwd}` ? 'secondary' : 'ghost'}
                    className="w-full justify-start pl-8 font-normal"
                    title={item.cwd}
                    onClick={() => setSection(`project:${item.cwd}`)}
                  >
                    <span className="truncate">{item.name}</span>
                  </Button>
                ))}
                {!projects.length ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">{t('mcp.noProjects')}</p>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>
      </nav>
      <div className="m-2 min-w-0 flex-1 overflow-hidden rounded-xl bg-card">
        <ScrollArea className="h-full [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-8">
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5" />
              <div>
                <h1 className="text-lg font-medium">
                  {project ? project.name : t(currentSection.title)}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {t(project ? 'mcp.projectDescription' : currentSection.description)}
                </p>
              </div>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {project ? <ProjectSettingsPane key={project.cwd} cwd={project.cwd} /> : null}
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
