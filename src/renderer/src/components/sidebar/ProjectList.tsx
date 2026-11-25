import { useRef } from 'react'
import { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { DEFAULT_SPACE_ID } from '../../../../shared/project-spaces'
import { cn } from '../../lib/utils'
import { spaceDisplayName } from '../../stores/project-spaces'
import { ProjectAvatar } from './ProjectAvatar'
import { ProjectRow } from './ProjectRow'
import { SpaceGlyph } from './space-icons'
import { useProjectList } from './use-project-list'
import { useT } from '../../hooks/useT'

export function ProjectList() {
  const t = useT()
  const {
    projects,
    activeSpace,
    activeSpaceIndex,
    colorIndexByCwd,
    isReorderingProjects,
    syncError,
    activeProject,
    activeIndex,
    clickGuard,
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel
  } = useProjectList()
  const currentSpaceId = activeSpace?.id ?? DEFAULT_SPACE_ID
  const prevSpaceRef = useRef<{ id: string; index: number } | null>(null)
  const slideDirectionRef = useRef<'left' | 'right' | null>(null)

  if (prevSpaceRef.current === null) {
    prevSpaceRef.current = { id: currentSpaceId, index: activeSpaceIndex }
  } else if (prevSpaceRef.current.id !== currentSpaceId) {
    slideDirectionRef.current = activeSpaceIndex >= prevSpaceRef.current.index ? 'right' : 'left'
    prevSpaceRef.current = { id: currentSpaceId, index: activeSpaceIndex }
  }

  const slideDirection = slideDirectionRef.current
  const spaceLabel = spaceDisplayName(activeSpace, t)
  const hasCustomIcon = Boolean(activeSpace?.icon && activeSpace.icon !== 'dot')

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      autoScroll={{ threshold: { x: 0.15, y: 0.15 } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext
        items={projects.map((project) => project.cwd)}
        strategy={verticalListSortingStrategy}
      >
        <div className="overflow-x-hidden">
          <div
            key={currentSpaceId}
            data-space-slide={slideDirection ?? undefined}
            className={cn(
              'flex flex-col gap-y-1 py-1',
              slideDirection === 'right' && 'space-slide-from-right',
              slideDirection === 'left' && 'space-slide-from-left'
            )}
          >
            <div
              data-space-header
              className="flex items-center gap-1 px-2 pt-0.5 pb-1 text-xs font-medium text-sidebar-foreground"
            >
              {hasCustomIcon ? (
                <SpaceGlyph icon={activeSpace?.icon} active className="size-3 text-muted-foreground" />
              ) : null}
              <span className="min-w-0 truncate">{spaceLabel}</span>
            </div>
            {syncError && (
              <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">
                {syncError}
              </p>
            )}
            {projects.length === 0 && (
              <p className="flex min-h-40 items-center justify-center px-2 py-8 text-center text-xs text-muted-foreground">
                {t('sidebar.projectsEmpty')}
              </p>
            )}
            {projects.map((project, index) => (
              <ProjectRow
                key={project.cwd}
                project={project}
                index={colorIndexByCwd.get(project.cwd) ?? index}
                disabled={isReorderingProjects}
                clickGuard={clickGuard}
              />
            ))}
          </div>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeProject ? (
          <div className="flex h-9 w-56 items-center gap-1.5 rounded-md bg-sidebar-accent px-1.5 shadow-md">
            <ProjectAvatar name={activeProject.name} index={activeIndex} />
            <span className="min-w-0 truncate text-xs font-normal">{activeProject.name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
