import { useEffect, useRef, useState } from 'react'
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { api } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'
import { errorMessage } from './project-action'

/** Keeps filesystem synchronization and drag ordering outside the project tree UI. */
export function useProjectList() {
  const projects = useSessionsStore((s) => s.projects)
  const reorderProjects = useSessionsStore((s) => s.reorderProjects)
  const isReorderingProjects = useSessionsStore((s) => s.isReorderingProjects)
  const refreshProject = useSessionsStore((s) => s.refreshProject)
  const loadProjects = useSessionsStore((s) => s.loadProjects)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const clickGuard = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const activeProject = activeId ? projects.find((project) => project.cwd === activeId) : undefined
  const activeIndex = activeProject
    ? projects.findIndex((project) => project.cwd === activeProject.cwd)
    : -1

  useEffect(() => {
    let disposed = false
    const refresh = (cwd?: string) => {
      void (cwd ? refreshProject(cwd) : loadProjects()).then(
        () => {
          if (!disposed) setSyncError(null)
        },
        (error: unknown) => {
          if (!disposed) setSyncError(errorMessage(error))
        }
      )
    }
    const unsubscribe = api.onProjectsChanged((cwd) => refresh(cwd))
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    refresh()
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshProject, loadProjects])

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
    const nextProjects = arrayMove(projects, oldIndex, newIndex)
    void reorderProjects(nextProjects.map((project) => project.cwd)).then(
      () => setSyncError(null),
      (error: unknown) => setSyncError(errorMessage(error))
    )
  }

  const handleDragCancel = () => clearDrag()

  return {
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
  }
}
