import { useEffect, useState } from 'react'
import { ChevronLeft, KeyRound, Palette, Settings2 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { GeneralPane } from './GeneralPane'
import { ThemePane } from './ThemePane'
import { ProvidersPane } from './ProvidersPane'

const sections = [
  {
    id: 'general',
    title: '通用',
    description: '核心行为和快捷键',
    icon: Settings2,
    component: GeneralPane
  },
  { id: 'theme', title: '主题', description: '外观和配色', icon: Palette, component: ThemePane },
  {
    id: 'providers',
    title: '供应商',
    description: '登录订阅账号，或保存 API 密钥',
    icon: KeyRound,
    component: ProvidersPane
  }
] as const

type SettingsSection = (typeof sections)[number]['id']

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>('general')
  const load = useSettingsStore((s) => s.load)
  const error = useSettingsStore((s) => s.error)
  const currentSection = sections.find((item) => item.id === section) ?? sections[0]
  const Icon = currentSection.icon

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (
        document.querySelector(
          '[data-slot=dialog-content], [data-slot=popover-content][data-state=open], [data-slot=select-content][data-state=open], [data-slot=dropdown-menu-content][data-state=open]'
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
      <nav className="flex w-62 shrink-0 flex-col gap-1 px-2">
        <div className="flex items-center gap-2 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <ChevronLeft data-icon="inline-start" />
            返回
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={onClose}>
            esc
          </Button>
        </div>
        {sections.map(({ id, title, icon: SectionIcon }) => (
          <Button
            key={id}
            type="button"
            variant={section === id ? 'secondary' : 'ghost'}
            className="justify-start font-normal"
            onClick={() => setSection(id)}
          >
            <SectionIcon data-icon="inline-start" />
            {title}
          </Button>
        ))}
      </nav>
      <div className="m-2 min-w-0 flex-1 overflow-hidden rounded-xl bg-card">
        <ScrollArea className="h-full [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-8">
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5" />
              <div>
                <h1 className="text-lg font-medium">{currentSection.title}</h1>
                <p className="text-sm text-muted-foreground">{currentSection.description}</p>
              </div>
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
