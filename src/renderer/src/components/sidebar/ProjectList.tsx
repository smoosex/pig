import { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ProjectAvatar } from './ProjectAvatar'
import { ProjectRow } from './ProjectRow'
import { useProjectList } from './use-project-list'
import { useT } from '../../hooks/useT'

export function ProjectList() {
  const t = useT()
  const {
    projects,
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
        <div className="flex flex-col gap-y-1 py-1">
          {syncError && (
            <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">
              {syncError}
            </p>
          )}
          {projects.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t('sidebar.projectsEmpty')}</p>
          )}
          {projects.map((project, index) => (
            <ProjectRow
              key={project.cwd}
              project={project}
              index={index}
              disabled={isReorderingProjects}
              clickGuard={clickGuard}
            />
          ))}
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
