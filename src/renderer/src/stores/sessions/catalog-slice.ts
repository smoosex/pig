/**
 * Project/chat discovery and membership changes.
 * Versions prevent a delayed directory scan from undoing a local reorder.
 */
import { api } from '../../ipc/api'
import { t } from '../../lib/i18n'
import { useDiffStore } from '../diff'
import {
  mapGroupSessions,
  mergeWorktreeDiscoveries,
  patchTabsFromGroups,
  removeCwdSessions,
  renameGroupSession,
  upsertGroup
} from './catalog'
import { sessionTitle } from './session-title'
import type { SessionSlice } from './types'

export const createCatalogSlice: SessionSlice<
  | 'projects'
  | 'chats'
  | 'isReorderingProjects'
  | 'loadProjects'
  | 'syncProjectWorktrees'
  | 'loadWorktreeSessions'
  | 'loadChats'
  | 'openProject'
  | 'unpinProject'
  | 'reorderProjects'
  | 'refreshProject'
  | 'refreshCwd'
  | 'createWorktree'
  | 'deleteWorktree'
  | 'deleteProject'
  | 'deleteChat'
  | 'deleteSession'
  | 'renameSession'
  | 'applySessionNames'
> = (set, get) => {
  let projectMembershipVersion = 0
  let projectOrderVersion = 0
  let projectLoadVersion = 0
  let latestProjectLoad: Promise<void> | null = null
  let worktreeDiscovery: Promise<void> | null = null
  const worktreeSessionLoads = new Map<string, Promise<void>>()
  let chatMembershipVersion = 0
  let chatLoadVersion = 0
  const refreshRequests = new Map<string, object>()

  async function waitForLatestProjectLoad(started: Promise<void>): Promise<void> {
    let current = started
    while (true) {
      try {
        await current
      } catch (error) {
        if (latestProjectLoad === current) throw error
      }
      const latest = latestProjectLoad
      if (!latest || latest === current) return
      current = latest
    }
  }

  return {
    projects: [],
    chats: [],
    isReorderingProjects: false,

    loadProjects: () => {
      const request = ++projectLoadVersion
      const version = projectMembershipVersion
      const orderVersion = projectOrderVersion
      const savingOrder = get().isReorderingProjects
      const operation = (async () => {
        const projects = await api.listProjects()
        if (
          request !== projectLoadVersion ||
          version !== projectMembershipVersion ||
          orderVersion !== projectOrderVersion ||
          savingOrder ||
          get().isReorderingProjects
        ) return
        set((s) => ({
          projects,
          openTabs: patchTabsFromGroups(s.openTabs, projects)
        }))
      })()
      latestProjectLoad = operation
      return waitForLatestProjectLoad(operation)
    },

    syncProjectWorktrees: () => {
      if (worktreeDiscovery) return worktreeDiscovery
      const membership = projectMembershipVersion
      const operation = (async () => {
        const discoveries = await api.discoverOpenedWorktrees()
        if (membership !== projectMembershipVersion) return
        set((state) => ({
          projects: mergeWorktreeDiscoveries(state.projects, discoveries)
        }))
      })()
      worktreeDiscovery = operation.finally(() => {
        worktreeDiscovery = null
      })
      return worktreeDiscovery
    },

    loadWorktreeSessions: (cwd) => {
      const project = get().projects.find((item) =>
        item.worktrees?.some((worktree) => worktree.cwd === cwd)
      )
      const worktree = project?.worktrees?.find((item) => item.cwd === cwd)
      if (!project || worktree?.sessionsLoaded !== false) return Promise.resolve()
      const pending = worktreeSessionLoads.get(cwd)
      if (pending) return pending
      const membership = projectMembershipVersion
      const operation = (async () => {
        const sessions = await api.listWorktreeSessions(project.cwd, cwd)
        if (membership !== projectMembershipVersion) return
        set((state) => ({
          projects: state.projects.map((item) => {
            if (item.cwd !== project.cwd || !item.worktrees?.some((entry) => entry.cwd === cwd)) {
              return item
            }
            const worktrees = item.worktrees.map((entry) => entry.cwd === cwd
              ? { ...entry, sessions, sessionsLoaded: true }
              : entry
            )
            return { ...item, worktrees, sessions: worktrees.flatMap((entry) => entry.sessions) }
          })
        }))
      })()
      const tracked = operation.finally(() => {
        worktreeSessionLoads.delete(cwd)
      })
      worktreeSessionLoads.set(cwd, tracked)
      return tracked
    },

    loadChats: async () => {
      const request = ++chatLoadVersion
      const membership = chatMembershipVersion
      const chats = await api.listChats()
      if (request !== chatLoadVersion || membership !== chatMembershipVersion) return
      set((s) => ({
        chats,
        openTabs: patchTabsFromGroups(s.openTabs, chats)
      }))
    },

    openProject: async () => {
      const project = await api.openProject()
      if (!project) return
      projectMembershipVersion++
      set((s) => {
        const index = s.projects.findIndex((item) => item.cwd === project.cwd)
        const projects = [...s.projects]
        if (index === -1) projects.push(project)
        else projects[index] = project
        return { projects }
      })
    },

    unpinProject: async (cwd) => {
      const project = get().projects.find((item) => item.cwd === cwd)
      await api.unpinProject(cwd)
      projectMembershipVersion++
      set((s) => {
        const cwds = new Set([
          cwd,
          ...(project?.worktrees ?? []).map((worktree) => worktree.cwd)
        ])
        return {
          projects: s.projects.filter((item) => item.cwd !== cwd),
          ...removeCwdSessions(s, cwds, project?.sessions ?? [])
        }
      })
    },

    reorderProjects: async (cwds) => {
      if (get().isReorderingProjects) throw new Error(t('sessions.sortingProjects'))
      const currentProjects = get().projects
      if (
        cwds.length !== currentProjects.length ||
        cwds.some((cwd) => typeof cwd !== 'string') ||
        new Set(cwds).size !== cwds.length
      ) {
        throw new Error(t('error.projectListChanged'))
      }
      const byCwd = new Map(currentProjects.map((project) => [project.cwd, project]))
      if (cwds.some((cwd) => !byCwd.has(cwd))) throw new Error(t('error.projectListChanged'))
      const nextProjects = cwds.map((cwd) => byCwd.get(cwd)!)
      if (nextProjects.every((project, index) => project.cwd === currentProjects[index]?.cwd)) return

      const previousProjects = currentProjects
      const membershipVersion = projectMembershipVersion
      const orderVersion = ++projectOrderVersion
      set({ projects: nextProjects, isReorderingProjects: true })
      try {
        await api.reorderProjects(cwds)
        if (projectOrderVersion === orderVersion) set({ isReorderingProjects: false })
      } catch (error) {
        if (projectOrderVersion === orderVersion) {
          set((s) => ({
            projects: projectMembershipVersion === membershipVersion ? previousProjects : s.projects,
            isReorderingProjects: false
          }))
          try {
            await get().loadProjects()
          } catch {
          }
        }
        throw error
      }
    },

    refreshProject: async (cwd) => {
      const request = {}
      const membership = projectMembershipVersion
      refreshRequests.set(cwd, request)
      try {
        const project = await api.listProject(cwd)
        if (refreshRequests.get(cwd) !== request || membership !== projectMembershipVersion) return
        projectLoadVersion++
        set((s) => ({
          projects: project
            ? s.projects.some((item) => item.cwd === project.cwd)
              ? upsertGroup(s.projects, project.cwd, project, true)
              : s.projects
            : s.projects.filter((item) => item.cwd !== cwd),
          openTabs: patchTabsFromGroups(s.openTabs, project ? [project] : [])
        }))
      } finally {
        if (refreshRequests.get(cwd) === request) refreshRequests.delete(cwd)
      }
    },

    refreshCwd: async (cwd) => {
      const membership = chatMembershipVersion
      if (await api.isChatCwd(cwd)) {
        const request = {}
        refreshRequests.set(cwd, request)
        try {
          const chat = await api.listProject(cwd)
          if (refreshRequests.get(cwd) !== request || membership !== chatMembershipVersion) return
          chatLoadVersion++
          set((s) => ({
            chats: upsertGroup(s.chats, cwd, chat, false, true),
            openTabs: patchTabsFromGroups(s.openTabs, chat ? [chat] : [])
          }))
        } finally {
          if (refreshRequests.get(cwd) === request) refreshRequests.delete(cwd)
        }
        return
      }
      await get().refreshProject(cwd)
    },

    createWorktree: async (projectCwd, options) => {
      const result = await api.createWorktree(projectCwd, options)
      if (!result) return null
      projectMembershipVersion++
      set((s) => ({
        projects: s.projects.some((project) => project.cwd === result.project.cwd)
          ? upsertGroup(s.projects, result.project.cwd, result.project, true)
          : s.projects,
        openTabs: patchTabsFromGroups(s.openTabs, [result.project])
      }))
      return result.cwd
    },

    deleteWorktree: async (projectCwd, cwd, force = false) => {
      const project = get().projects.find((item) => item.cwd === projectCwd)
      if (cwd === projectCwd || project?.worktrees?.some((worktree) => worktree.cwd === cwd && worktree.isPrimary)) {
        throw new Error(t('sessions.cannotDeleteRoot'))
      }
      const result = await api.deleteWorktree(projectCwd, cwd, force)
      if (!result) return
      useDiffStore.getState().forgetWorktree(cwd)
      projectMembershipVersion++
      set((s) => {
        const current = s.projects.find((item) => item.cwd === projectCwd)
        return {
          ...removeCwdSessions(s, new Set([cwd]), [
            ...(project?.sessions ?? []),
            ...(current?.sessions ?? [])
          ]),
          projects: s.projects.some((item) => item.cwd === result.project.cwd)
            ? upsertGroup(s.projects, result.project.cwd, result.project, true)
            : s.projects
        }
      })
    },

    deleteProject: async (cwd) => {
      const project = get().projects.find((item) => item.cwd === cwd)
      if (!(await api.deleteProject(cwd))) return
      for (const worktreeCwd of new Set([
        cwd,
        ...(project?.worktrees ?? []).map((worktree) => worktree.cwd)
      ])) {
        useDiffStore.getState().forgetWorktree(worktreeCwd)
      }
      projectMembershipVersion++
      set((s) => {
        const current = s.projects.find((item) => item.cwd === cwd)
        const sessions = [...(project?.sessions ?? []), ...(current?.sessions ?? [])]
        const cwds = new Set([
          cwd,
          ...(project?.worktrees ?? []).map((worktree) => worktree.cwd),
          ...(current?.worktrees ?? []).map((worktree) => worktree.cwd),
          ...sessions.map((session) => session.cwd)
        ])
        return {
          projects: s.projects.filter((item) => item.cwd !== cwd),
          ...removeCwdSessions(s, cwds, sessions)
        }
      })
    },

    deleteChat: async (cwd) => {
      await api.deleteChat(cwd)
      chatMembershipVersion++
      set((s) => ({
        chats: s.chats.filter((chat) => chat.cwd !== cwd),
        ...removeCwdSessions(s, new Set([cwd]), s.chats.flatMap((chat) => chat.sessions))
      }))
    },

    deleteSession: async (meta) => {
      await api.deleteSession(meta.id, meta.path, meta.cwd)
      projectMembershipVersion++
      chatMembershipVersion++

      set((s) => {
        const deletedTab = s.openTabs.find((tab) => tab.id === meta.id)
        const openTabs = s.openTabs.filter((tab) => tab.id !== meta.id)
        const runtime = { ...s.runtime }
        delete runtime[meta.id]
        const activeSessionByCwd = { ...s.activeSessionByCwd }
        if (deletedTab?.kind === 'project' && activeSessionByCwd[deletedTab.cwd] === meta.id) {
          activeSessionByCwd[deletedTab.cwd] = openTabs.findLast((tab) =>
            tab.kind === 'project' && tab.cwd === deletedTab.cwd
          )?.id ?? null
        }
        const activeWasDeleted = s.activeTabId === meta.id
        const projects = s.projects.map((project) =>
          mapGroupSessions(project, (sessions) => sessions.filter((session) => session.id !== meta.id))
        )
        return {
          projects,
          chats: s.chats.map((chat) =>
            mapGroupSessions(chat, (sessions) => sessions.filter((session) => session.id !== meta.id))
          ),
          openTabs,
          runtime,
          activeSessionByCwd,
          activeTabId: activeWasDeleted
            ? deletedTab?.kind === 'project'
              ? activeSessionByCwd[deletedTab.cwd] ?? null
              : openTabs.findLast((tab) => tab.kind === 'chat')?.id ?? null
            : s.activeTabId
        }
      })
      const next = get().activeTabId
      if (next && !get().runtime[next]) await get().activateTab(next)
    },

    renameSession: async (sessionId, name, path) => {
      const clean = name.replace(/[\r\n]+/g, ' ').trim()
      await api.renameSession(sessionId, clean, path)
      const display = clean || undefined
      set((s) => ({
        projects: renameGroupSession(s.projects, sessionId, display),
        chats: renameGroupSession(s.chats, sessionId, display),
        openTabs: s.openTabs.map((tab) => {
          if (tab.id !== sessionId) return tab
          if (!tab.meta) return { ...tab, title: display ?? tab.title, previewFallback: undefined }
          const meta = { ...tab.meta, name: display }
          return { ...tab, meta, title: sessionTitle(meta), previewFallback: undefined }
        })
      }))
    },

    applySessionNames: (updates) => {
      if (updates.length === 0) return
      const names = new Map(updates.map((update) => [update.sessionId, update.name]))
      set((s) => ({
        projects: [...names].reduce((groups, [id, name]) => renameGroupSession(groups, id, name), s.projects),
        chats: [...names].reduce((groups, [id, name]) => renameGroupSession(groups, id, name), s.chats),
        // A pushed name is never empty, so a tab showing only a first message takes it as its title.
        openTabs: s.openTabs.map((tab) => {
          const name = names.get(tab.id)
          if (!name) return tab
          if (!tab.meta) return { ...tab, title: name, previewFallback: undefined }
          const meta = { ...tab.meta, name }
          return { ...tab, meta, title: sessionTitle(meta), previewFallback: undefined }
        })
      }))
    }
  }
}
