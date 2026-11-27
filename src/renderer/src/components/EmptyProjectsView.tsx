import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { ArrowRight, Folder, FolderInput, Sparkles, Terminal } from 'lucide-react'
import { resolveProjectSpaceId, type ProjectSpace } from '../../../shared/project-spaces'
import { useT } from '../hooks/useT'
import { cn, hideScroll } from '../lib/utils'
import { spaceDisplayName, useProjectSpacesStore } from '../stores/project-spaces'
import { useSessionsStore } from '../stores/sessions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { ProjectAvatar } from './sidebar/ProjectAvatar'

function timeGreetingKey(hour = new Date().getHours()):
  | 'app.greetingMorning'
  | 'app.greetingAfternoon'
  | 'app.greetingEvening' {
  if (hour >= 5 && hour < 12) return 'app.greetingMorning'
  if (hour >= 12 && hour < 18) return 'app.greetingAfternoon'
  return 'app.greetingEvening'
}

const ActionCard = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & {
    title: string
    description: string
    icon: ReactNode
  }
>(function ActionCard({ title, description, icon, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      data-slot="card"
      className={cn(
        'group/empty-card relative flex min-h-31 cursor-pointer flex-col justify-between rounded-2xl bg-glass-composer-background/65 p-4 text-left shadow-glass-card ring-1 ring-glass-card-border transition-[background-color,box-shadow] duration-150 ease-out outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-glass-card-edge hover:bg-glass-composer-background/90 focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring motion-reduce:transition-none solid:bg-muted/65 solid:shadow-2xs solid:ring-border solid:after:shadow-none solid:hover:bg-muted',
        className
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{description}</div>
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-muted-foreground transition-colors duration-150 group-hover/empty-card:text-foreground [&_svg]:size-4 [&_svg]:stroke-[1.75]">
          {icon}
        </span>
        <span className="flex size-6 items-center justify-center rounded-full bg-glass-prompt-foreground/7 text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out group-hover/empty-card:translate-x-0.5 group-hover/empty-card:bg-glass-prompt-foreground/12 group-hover/empty-card:text-foreground motion-reduce:transition-none solid:bg-foreground/6 solid:group-hover/empty-card:bg-foreground/11">
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </button>
  )
})

export function EmptyProjectsView({
  activeSpace,
  onOpenProject,
  onOpenBot,
  onOpenTerminal
}: {
  activeSpace?: ProjectSpace
  onOpenProject: () => void
  onOpenBot: () => void
  onOpenTerminal: () => void
}) {
  const t = useT()
  const projects = useSessionsStore((s) => s.projects)
  const spaces = useProjectSpacesStore((s) => s.spaces)
  const activeSpaceId = useProjectSpacesStore((s) => s.activeSpaceId)
  const assignments = useProjectSpacesStore((s) => s.assignments)
  const assignProject = useProjectSpacesStore((s) => s.assignProject)

  const otherProjects = projects.flatMap((project, index) => {
    const ownerId = resolveProjectSpaceId({ spaces, assignments }, project.cwd)
    if (ownerId === activeSpaceId) return []
    const owner = spaces.find((space) => space.id === ownerId)
    return [{ project, index, ownerLabel: spaceDisplayName(owner, t) }]
  })

  const hasGlobalProjects = projects.length > 0
  const subtitle = hasGlobalProjects
    ? t('spaces.emptyDescription', { name: spaceDisplayName(activeSpace, t) })
    : t('app.emptyProjectsDescription')

  return (
    <div
      data-empty-projects
      className="@container/empty-stage flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12 select-none"
    >
      <div className="flex max-w-lg flex-col items-center text-center">
        <h2 className="font-wenkai text-3xl font-normal tracking-tight text-foreground">
          {t(timeGreetingKey())}
        </h2>
        <p className="mt-2.5 text-sm text-muted-foreground">{subtitle}</p>
      </div>

      <div className="mt-8 grid w-full max-w-156 grid-cols-1 gap-3 @xl/empty-stage:grid-cols-3">
        <ActionCard
          data-empty-card="open-project"
          title={t('app.emptyCardOpenTitle')}
          description={t('app.emptyCardOpenDescription')}
          icon={<Folder aria-hidden="true" />}
          onClick={onOpenProject}
        />

        {otherProjects.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ActionCard
                data-empty-card="move-project"
                title={t('spaces.emptyCardMoveTitle')}
                description={t('spaces.emptyCardMoveDescription')}
                icon={<FolderInput aria-hidden="true" />}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className={cn('max-h-72 w-60 overflow-y-auto', hideScroll)}>
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t('spaces.emptyMoveMenuLabel')}
                </DropdownMenuLabel>
                {otherProjects.map(({ project, index, ownerLabel }) => (
                  <DropdownMenuItem
                    key={project.cwd}
                    onSelect={() => void assignProject(project.cwd, activeSpaceId)}
                  >
                    <ProjectAvatar name={project.name} index={index} />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{ownerLabel}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <ActionCard
            data-empty-card="terminal"
            title={t('app.emptyCardTerminalTitle')}
            description={t('app.emptyCardTerminalDescription')}
            icon={<Terminal aria-hidden="true" />}
            onClick={onOpenTerminal}
          />
        )}

        <ActionCard
          data-empty-card="bot"
          title={t('app.emptyCardBotTitle')}
          description={t('app.emptyCardBotDescription')}
          icon={<Sparkles aria-hidden="true" />}
          onClick={onOpenBot}
        />
      </div>
    </div>
  )
}
