import { useEffect, useMemo, useRef } from 'react'
import {
  resolveProjectSpaceId,
  resolveSpaceTargetCwd,
  resolveWorktreeSpaceId
} from '../../../../shared/project-spaces'
import { useProjectSpacesStore } from '../../stores/project-spaces'
import { useSessionsStore } from '../../stores/sessions'
import { isChatScope } from '../../stores/sessions/tab-order'

/**
 * Synchronizes the main content area with the active Project Space:
 * - Switching spaces activates that space's remembered worktree (`lastCwds`), or an open tab in that
 *   space, or its first project's New Session home, or clears the main area to the Empty Space screen
 *   when the space has no projects.
 * - Explicitly opening/jumping to a project in another space (via notifications, bookmarks, Kanban,
 *   or Bot) switches `activeSpaceId` to match without overriding the selected worktree.
 */
export function useSpaceWorkspaceSync() {
  const workspaceRestoreReady = useSessionsStore((s) => s.workspaceRestoreReady)
  const workspaceRestoreError = useSessionsStore((s) => s.workspaceRestoreError)
  const projects = useSessionsStore((s) => s.projects)
  const currentProjectCwd = useSessionsStore((s) => s.currentProjectCwd)
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const openTabs = useSessionsStore((s) => s.openTabs)
  const activeSessionByCwd = useSessionsStore((s) => s.activeSessionByCwd)
  const selectProjectCwd = useSessionsStore((s) => s.selectProjectCwd)
  const focusChatHome = useSessionsStore((s) => s.focusChatHome)

  const spacesReady = useProjectSpacesStore((s) => s.ready)
  const spaces = useProjectSpacesStore((s) => s.spaces)
  const activeSpaceId = useProjectSpacesStore((s) => s.activeSpaceId)
  const assignments = useProjectSpacesStore((s) => s.assignments)
  const lastCwds = useProjectSpacesStore((s) => s.lastCwds)

  const activeSpace = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId) ?? spaces[0],
    [spaces, activeSpaceId]
  )
  const spaceProjects = useMemo(
    () =>
      projects.filter(
        (project) => resolveProjectSpaceId({ spaces, assignments }, project.cwd) === activeSpaceId
      ),
    [projects, spaces, assignments, activeSpaceId]
  )

  const prevSpaceIdRef = useRef<string | null>(null)
  const prevCwdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceRestoreReady || !spacesReady || workspaceRestoreError) return

    const prevSpaceId = prevSpaceIdRef.current
    const prevCwd = prevCwdRef.current
    const spaceChanged = prevSpaceId !== null && prevSpaceId !== activeSpaceId
    const cwdChanged = currentProjectCwd !== prevCwd
    const currentOwnerSpaceId = resolveWorktreeSpaceId({ spaces, assignments }, projects, currentProjectCwd)

    prevSpaceIdRef.current = activeSpaceId
    prevCwdRef.current = currentProjectCwd

    const hasOpenContent = (cwd: string): boolean =>
      Boolean(activeSessionByCwd[cwd]) ||
      openTabs.some((tab) => !isChatScope(tab) && tab.cwd === cwd)

    const applySpaceTarget = () => {
      const targetCwd = resolveSpaceTargetCwd({
        spaceId: activeSpaceId,
        spaces,
        assignments,
        lastCwds,
        projects,
        hasOpenContent
      })
      if (targetCwd) {
        prevCwdRef.current = targetCwd
        void selectProjectCwd(targetCwd)
        void useProjectSpacesStore.getState().rememberCwd(activeSpaceId, targetCwd)
      } else if (currentProjectCwd !== null || activeTabId !== null) {
        prevCwdRef.current = null
        focusChatHome()
      }
    }

    // 1. Space switched: update main area to the target space's remembered or default content.
    if (spaceChanged) {
      if (currentProjectCwd && currentOwnerSpaceId === activeSpaceId) {
        void useProjectSpacesStore.getState().rememberCwd(activeSpaceId, currentProjectCwd)
        return
      }
      applySpaceTarget()
      return
    }

    // 2. Worktree changed explicitly (sidebar click, notification, bookmark, Kanban, or Bot jump).
    if (cwdChanged && currentProjectCwd && currentOwnerSpaceId) {
      void useProjectSpacesStore.getState().rememberCwd(currentOwnerSpaceId, currentProjectCwd)
      if (currentOwnerSpaceId !== activeSpaceId) {
        prevSpaceIdRef.current = currentOwnerSpaceId
        void useProjectSpacesStore.getState().selectSpace(currentOwnerSpaceId)
      }
      return
    }

    // 3. Active project was moved out of the current space or removed from projects.
    if (currentProjectCwd && currentOwnerSpaceId !== activeSpaceId) {
      applySpaceTarget()
      return
    }

    // 4. Empty main area while the active space has projects (e.g. first project added into an empty space).
    const activeTab = activeTabId ? openTabs.find((tab) => tab.id === activeTabId) : undefined
    if (!currentProjectCwd && !activeTab) {
      if (spaceProjects.length > 0) {
        applySpaceTarget()
      }
      return
    }

    // 5. Keep the active space's remembered worktree up to date.
    if (currentProjectCwd && currentOwnerSpaceId === activeSpaceId && lastCwds[activeSpaceId] !== currentProjectCwd) {
      void useProjectSpacesStore.getState().rememberCwd(activeSpaceId, currentProjectCwd)
    }
  }, [
    workspaceRestoreReady,
    spacesReady,
    workspaceRestoreError,
    activeSpaceId,
    spaces,
    assignments,
    lastCwds,
    projects,
    spaceProjects.length,
    currentProjectCwd,
    activeTabId,
    openTabs,
    activeSessionByCwd,
    selectProjectCwd,
    focusChatHome
  ])

  return { activeSpace, spaceProjects }
}
