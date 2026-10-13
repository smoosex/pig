/**
 * Project/chat discovery, membership changes and sidebar expansion.
 * Expansion belongs to the catalog rather than its mounted rows, so switching halves preserves it.
 * Versions prevent a delayed directory scan from undoing a local reorder.
 */
import { api } from '../../ipc/api'
import { compareGroupsByLatestSession } from '../../../../shared/session-order'
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
import { neighbourAmong } from './tab-order'
import { sessionTitle } from './session-title'
import type { SessionSlice } from './types'

export const createCatalogSlice: SessionSlice<
  | 'projects'
  | 'chats'
  | 'isReorderingProjects'
  | 'expandedProjects'
  | 'expandedWorktrees'
  | 'setProjectExpanded'
  | 'setWorktreeExpanded'
  | 'revealProjectWorktree'
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
  | 'applyWorktreeDeletions'
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
  /**
   * The chats scan in flight. The restore and the sidebar both ask at launch, and a chat tab needs the
   * listing for its title and the file to open, so one scan has to serve both — but only while it is the
   * same question: a membership change takes the next caller to a fresh scan.
   */
  let chatLoad: { membership: number; request: Promise<void> } | null = null
  const refreshRequests = new Map<string, object>()
  const revealedWorktreeByProject = new Map<string, string>()

  async function waitForLatestProjectLoad(started: Promise<void>): Promise<void> {
    let current = started
    while (true) {
      try {
        await current
      } catch (error) {
        // Only a superseded scan may be ignored; callers still await and receive the latest result.
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
    expandedProjects: {},
    expandedWorktrees: {},

    setProjectExpanded: (projectCwd, expanded) =>
      set((s) => ({
        expandedProjects: { ...s.expandedProjects, [projectCwd]: expanded }
      })),

    setWorktreeExpanded: (worktreeCwd, expanded) =>
      set((s) => ({
        expandedWorktrees: { ...s.expandedWorktrees, [worktreeCwd]: expanded }
      })),

    revealProjectWorktree: (projectCwd, worktreeCwd) => {
      if (worktreeCwd === null) {
        revealedWorktreeByProject.delete(projectCwd)
        return
      }
      // A remount is not another selection: keep manual folds until the active worktree changes.
      if (revealedWorktreeByProject.get(projectCwd) === worktreeCwd) return
      revealedWorktreeByProject.set(projectCwd, worktreeCwd)
      set((s) => ({
        expandedProjects: { ...s.expandedProjects, [projectCwd]: true },
        expandedWorktrees: { ...s.expandedWorktrees, [worktreeCwd]: true }
      }))
    },

    loadProjects: () => {
      const request = ++projectLoadVersion
      const version = projectMembershipVersion
      const orderVersion = projectOrderVersion
      const savingOrder = get().isReorderingProjects
      const operation = (async () => {
        const projects = await api.listProjects()
        if (
          request !== projectLoadVersion ||
          orderVersion !== projectOrderVersion ||
          savingOrder ||
          get().isReorderingProjects
        ) return
        // A deletion may precede the first catalog. Read fresh membership rather than restoring
        // deleted worktrees or leaving startup with no projects after rejecting the stale scan.
        if (version !== projectMembershipVersion) return get().loadProjects()
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

    loadChats: () => {
      if (chatLoad && chatLoad.membership === chatMembershipVersion) return chatLoad.request
      const request = ++chatLoadVersion
      const membership = chatMembershipVersion
      const operation = (async () => {
        const chats = await api.listChats()
        if (request !== chatLoadVersion || membership !== chatMembershipVersion) return
        set((s) => ({
          chats,
          openTabs: patchTabsFromGroups(s.openTabs, chats)
        }))
      })().finally(() => {
        if (chatLoad?.request === operation) chatLoad = null
      })
      chatLoad = { membership, request: operation }
      return operation
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
      // The worktrees this drops may be what a restore or a switch is still heading for.
      get().invalidateSelection()
      set((s) => {
        const cwds = new Set([
          cwd,
          ...(project?.worktrees ?? []).map((worktree) => worktree.cwd)
        ])
        const expandedProjects = { ...s.expandedProjects }
        const expandedWorktrees = { ...s.expandedWorktrees }
        delete expandedProjects[cwd]
        for (const dropCwd of cwds) {
          delete expandedWorktrees[dropCwd]
        }
        revealedWorktreeByProject.delete(cwd)
        return {
          projects: s.projects.filter((item) => item.cwd !== cwd),
          ...removeCwdSessions(s, cwds, project?.sessions ?? []),
          expandedProjects,
          expandedWorktrees
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
            chats: upsertGroup(s.chats, cwd, chat, false).sort(compareGroupsByLatestSession),
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
      get().applyWorktreeDeletions([result.cwd])
    },

    applyWorktreeDeletions: (cwds) => {
      const targets = new Set(cwds)
      if (targets.size === 0) return
      projectMembershipVersion++
      if (!get().projects.some((project) => project.worktrees?.some((worktree) => targets.has(worktree.cwd)))
        && !get().openTabs.some((tab) => targets.has(tab.cwd))
        && !targets.has(get().currentProjectCwd ?? '')) return
      get().invalidateSelection()
      for (const cwd of targets) useDiffStore.getState().forgetWorktree(cwd)
      for (const [projectCwd, worktreeCwd] of revealedWorktreeByProject) {
        if (targets.has(worktreeCwd)) revealedWorktreeByProject.delete(projectCwd)
      }
      set((state) => {
        const expandedWorktrees = { ...state.expandedWorktrees }
        for (const cwd of targets) {
          delete expandedWorktrees[cwd]
        }
        return {
          ...removeCwdSessions(state, targets, state.projects.flatMap((project) => project.sessions)),
          projects: state.projects.map((project) => ({
            ...project,
            sessions: project.sessions.filter((session) => !targets.has(session.cwd)),
            worktrees: project.worktrees?.filter((worktree) => !targets.has(worktree.cwd))
          })),
          expandedWorktrees
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
      get().invalidateSelection()
      set((s) => {
        const current = s.projects.find((item) => item.cwd === cwd)
        const sessions = [...(project?.sessions ?? []), ...(current?.sessions ?? [])]
        const cwds = new Set([
          cwd,
          ...(project?.worktrees ?? []).map((worktree) => worktree.cwd),
          ...(current?.worktrees ?? []).map((worktree) => worktree.cwd),
          ...sessions.map((session) => session.cwd)
        ])
        const expandedProjects = { ...s.expandedProjects }
        const expandedWorktrees = { ...s.expandedWorktrees }
        delete expandedProjects[cwd]
        for (const dropCwd of cwds) {
          delete expandedWorktrees[dropCwd]
        }
        revealedWorktreeByProject.delete(cwd)
        return {
          projects: s.projects.filter((item) => item.cwd !== cwd),
          ...removeCwdSessions(s, cwds, sessions),
          expandedProjects,
          expandedWorktrees
        }
      })
    },

    deleteChat: async (cwd) => {
      await api.deleteChat(cwd)
      chatMembershipVersion++
      const closedIds = new Set([
        ...get().openTabs.filter((tab) => tab.kind === 'chat' && tab.cwd === cwd).map((tab) => tab.id),
        ...get().chats.filter((chat) => chat.cwd === cwd).flatMap((chat) => chat.sessions.map((meta) => meta.id))
      ])
      set((s) => ({
        chats: s.chats.filter((chat) => chat.cwd !== cwd),
        ...removeCwdSessions(s, new Set([cwd]), s.chats.flatMap((chat) => chat.sessions))
      }))
      get().persistOpenChatTabs([...closedIds])
      const next = get().openTabs.find((tab) => tab.id === get().activeTabId)
      if (next?.loadState === 'cold') await get().activateTab(next.id)
    },

    deleteSession: async (meta) => {
      await api.deleteSession(meta.id, meta.path, meta.cwd)
      projectMembershipVersion++
      chatMembershipVersion++
      const deletedChatTab = get().openTabs.some((tab) => tab.id === meta.id && tab.kind === 'chat') ||
        get().chats.some((chat) => chat.sessions.some((session) => session.id === meta.id))

      set((s) => {
        const deletedTab = s.openTabs.find((tab) => tab.id === meta.id)
        const openTabs = s.openTabs.filter((tab) => tab.id !== meta.id)
        const runtime = { ...s.runtime }
        delete runtime[meta.id]
        const activeSessionByCwd = { ...s.activeSessionByCwd }
        // A deleted session hands the strip to the neighbour it sat next to, not to whatever was opened
        // last: the order the reader arranged has no "end of the list means newest" in it any more. The
        // neighbour has to be a session of the same half rather than any surviving tab, since a changes or
        // file tab cannot stand in for a worktree's remembered session.
        const neighbourSession = deletedTab
          ? neighbourAmong(s.openTabs, deletedTab, (tab) => tab.kind === deletedTab.kind)
          : null
        if (deletedTab?.kind === 'project' && activeSessionByCwd[deletedTab.cwd] === meta.id) {
          activeSessionByCwd[deletedTab.cwd] = neighbourSession?.id ?? null
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
              : neighbourSession?.id ?? null
            : s.activeTabId
        }
      })
      if (deletedChatTab) get().persistOpenChatTabs([meta.id])
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
