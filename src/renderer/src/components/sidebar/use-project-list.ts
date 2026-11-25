import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { resolveProjectSpaceId } from '../../../../shared/project-spaces'
import { api } from '../../ipc/api'
import { useProjectSpacesStore } from '../../stores/project-spaces'
import { useSessionsStore } from '../../stores/sessions'
import { failureMessage } from '../../lib/ipc-error'

/** Keeps filesystem synchronization, space filtering, and drag ordering outside the project tree UI. */
export function useProjectList() {
  const allProjects = useSessionsStore((s) => s.projects)
  const spaces = useProjectSpacesStore((s) => s.spaces)
  const activeSpaceId = useProjectSpacesStore((s) => s.activeSpaceId)
  const assignments = useProjectSpacesStore((s) => s.assignments)
  const reorderProjects = useSessionsStore((s) => s.reorderProjects)
  const isReorderingProjects = useSessionsStore((s) => s.isReorderingProjects)
  const refreshProject = useSessionsStore((s) => s.refreshProject)
  const syncProjectWorktrees = useSessionsStore((s) => s.syncProjectWorktrees)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const clickGuard = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) => resolveProjectSpaceId({ spaces, assignments }, project.cwd) === activeSpaceId
      ),
    [allProjects, spaces, assignments, activeSpaceId]
  )
  const colorIndexByCwd = useMemo(
    () => new Map(allProjects.map((project, index) => [project.cwd, index])),
    [allProjects]
  )
  const activeSpaceIndex = useMemo(() => {
    const idx = spaces.findIndex((space) => space.id === activeSpaceId)
    return idx === -1 ? 0 : idx
  }, [spaces, activeSpaceId])
  const activeSpace = spaces[activeSpaceIndex] ?? spaces[0]
  const activeProject = activeId ? projects.find((project) => project.cwd === activeId) : undefined
  const activeIndex = activeProject ? (colorIndexByCwd.get(activeProject.cwd) ?? 0) : -1

  useEffect(() => {
    let disposed = false
    const refresh = (cwd: string) => {
      void refreshProject(cwd).then(
        () => {
          if (!disposed) setSyncError(null)
        },
        (error: unknown) => {
          if (!disposed) setSyncError(failureMessage(error))
        }
      )
    }
    const sync = () => {
      void syncProjectWorktrees().then(
        () => {
          if (!disposed) setSyncError(null)
        },
        (error: unknown) => {
          if (!disposed) setSyncError(failureMessage(error))
        }
      )
    }
    const unsubscribe = api.onProjectsChanged((cwd) => refresh(cwd))
    window.addEventListener('focus', sync)
    sync()
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('focus', sync)
    }
  }, [refreshProject, syncProjectWorktrees])

  const clearDrag = () => {
    setActiveId(null)
    requestAnimationFrame(() => {
      clickGuard.current = false
    })
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    clickGuard.current = true
    setActiveId(String(active.id))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    clearDrag()
    if (!over || active.id === over.id) return
    const oldIndex = projects.findIndex((project) => project.cwd === active.id)
    const newIndex = projects.findIndex((project) => project.cwd === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const nextVisible = arrayMove(projects, oldIndex, newIndex)
    const visibleSet = new Set(projects.map((project) => project.cwd))
    let cursor = 0
    const nextOrder = allProjects.map((project) =>
      visibleSet.has(project.cwd) ? nextVisible[cursor++]!.cwd : project.cwd
    )
    void reorderProjects(nextOrder).then(
      () => setSyncError(null),
      (error: unknown) => setSyncError(failureMessage(error))
    )
  }

  const handleDragCancel = () => clearDrag()

  return {
    projects,
    spacesCount: spaces.length,
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
  }
}
