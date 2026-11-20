/**
 * Zustand store for Pig Bot UI: owns Bot page open/close state, single-timeline items,
 * background task ledger projection, anti-stacking peek bubble queue, and radial-reveal coordination.
 */
import { create } from 'zustand'
import type { SessionControls, ThinkingLevel } from '../../../shared/api'
import type { PermissionMode } from '../../../shared/permissions'
import {
  isBotTaskActive,
  type BotEvent,
  type BotImageAttachment,
  type BotMirroredApproval,
  type BotPeekMessage,
  type BotSnapshot,
  type BotState,
  type BotTask,
  type BotTextAttachment,
  type BotTimelineItem
} from '../../../shared/bot'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'
import { elementCenterOrigin, runBotRadialReveal } from '../lib/radial-reveal'

export interface BotPeekState {
  message: BotPeekMessage
  extraCount: number
}

const LIVE_STATUS_PRIORITY: Record<string, number> = {
  blocked_approval: 0,
  starting: 1,
  running: 2
}

/** Sort active tasks for the live task strip: approval > starting > running, newest first within rank. */
export function sortLiveBotTasks(tasks: readonly BotTask[]): BotTask[] {
  return tasks
    .filter((t) => isBotTaskActive(t.status))
    .sort((a, b) => {
      const pa = LIVE_STATUS_PRIORITY[a.status] ?? 9
      const pb = LIVE_STATUS_PRIORITY[b.status] ?? 9
      if (pa !== pb) return pa - pb
      return b.updatedAt - a.updatedAt
    })
}

export interface BotStoreState {
  loaded: boolean
  loading: boolean
  error: string | null
  open: boolean
  drawerOpen: boolean
  focusedTaskId: string | null
  state: BotState | null
  timeline: BotTimelineItem[]
  tasks: BotTask[]
  streaming: boolean
  unreadCount: number
  approvals: BotMirroredApproval[]
  controls: SessionControls | null
  permissionMode: PermissionMode
  peek: BotPeekState | null
  stoppingTaskIds: Record<string, boolean>
  draftInput: string
  draftRevision: number

  init: () => Promise<void>
  applySnapshot: (snapshot: BotSnapshot, restoreSurface?: boolean) => void
  applyEvent: (event: BotEvent) => void
  openBot: (originEl?: Element | null) => void
  closeBot: (originEl?: Element | null) => void
  toggleBot: (originEl?: Element | null) => void
  setDrawerOpen: (open: boolean, focusTaskId?: string | null) => void
  toggleDrawer: () => void
  dismissPeek: () => void
  setDraftInput: (value: string) => void

  sendMessage: (input: {
    text: string
    images?: BotImageAttachment[]
    textAttachments?: BotTextAttachment[]
    projectMentions?: string[]
  }) => Promise<void>
  retryLastMessage: () => Promise<void>
  abortCurrentTurn: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (provider: string, id: string) => Promise<void>
  setThinking: (level: ThinkingLevel) => Promise<void>
  resetContext: () => Promise<void>
  stopTask: (taskId: string) => Promise<void>
  takeOverTask: (taskId: string) => Promise<BotTask>
  followupTask: (taskId: string, instruction: string) => Promise<void>
  cleanupWorktree: (taskId: string, confirmation?: string) => Promise<void>
}

let orbAnchorElement: HTMLElement | null = null
let unsubscribeBotEvents: (() => void) | null = null
let initPromise: Promise<void> | null = null
let initializingEvents: BotEvent[] | null = null

export function registerBotOrbAnchor(element: HTMLElement | null): void {
  orbAnchorElement = element
}

export function getBotOrbAnchor(): HTMLElement | null {
  return orbAnchorElement
}

function upsertTimeline(list: BotTimelineItem[], item: BotTimelineItem): BotTimelineItem[] {
  if (list.some((existing) => existing.id === item.id)) return list
  return [...list, item]
}

function upsertTask(list: BotTask[], task: BotTask): BotTask[] {
  const idx = list.findIndex((t) => t.taskId === task.taskId)
  if (idx === -1) return [task, ...list]
  const next = list.slice()
  next[idx] = task
  return next
}

export const useBotStore = create<BotStoreState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  open: false,
  drawerOpen: false,
  focusedTaskId: null,
  state: null,
  timeline: [],
  tasks: [],
  streaming: false,
  unreadCount: 0,
  approvals: [],
  controls: null,
  permissionMode: 'full-access',
  peek: null,
  stoppingTaskIds: {},
  draftInput: '',
  draftRevision: 0,

  init: async () => {
    if (get().loaded) return
    if (!api?.bot) return
    if (initPromise) return initPromise
    set({ loading: true, error: null })
    initializingEvents = []
    initPromise = (async () => {
      try {
        unsubscribeBotEvents ??= api.bot.onEvent((event) => {
          if (initializingEvents) initializingEvents.push(event)
          else get().applyEvent(event)
        })
        const snapshot = await api.bot.getSnapshot()
        get().applySnapshot(snapshot, true)
        for (const event of initializingEvents ?? []) {
          if (event.cursor === undefined || event.cursor > (snapshot.eventCursor ?? -1)) get().applyEvent(event)
        }
      } catch (error) {
        set({ loading: false, error: failureMessage(error) })
      } finally {
        initializingEvents = null
        initPromise = null
      }
    })()
    return initPromise
  },

  applySnapshot: (snapshot, restoreSurface = false) => {
    set((prev) => {
      const open = restoreSurface ? snapshot.state.lastSurface === 'bot' : prev.open
      return {
        loaded: true,
        loading: false,
        error: null,
        open,
        state: snapshot.state,
        timeline: snapshot.timeline,
        tasks: snapshot.tasks,
        streaming: snapshot.streaming,
        unreadCount: open ? 0 : snapshot.unreadCount,
        approvals: snapshot.approvals,
        controls: snapshot.controls,
        permissionMode: snapshot.permissionMode,
        peek: open ? null : prev.peek
      }
    })
  },

  applyEvent: (event) => {
    set((prev) => {
      switch (event.type) {
        case 'timeline_item': {
          const isAssistantOrFallback = event.item.kind !== 'user'
          return {
            timeline: upsertTimeline(prev.timeline, event.item),
            unreadCount: !prev.open && isAssistantOrFallback && !prev.timeline.some((item) => item.id === event.item.id) ? prev.unreadCount + 1 : prev.unreadCount
          }
        }
        case 'timeline_replaced':
          return { timeline: event.timeline }
        case 'streaming_changed':
          return { streaming: event.streaming }
        case 'task_updated': {
          const stopping = { ...prev.stoppingTaskIds }
          if (!isBotTaskActive(event.task.status)) delete stopping[event.task.taskId]
          return {
            tasks: upsertTask(prev.tasks, event.task),
            stoppingTaskIds: stopping
          }
        }
        case 'tasks_replaced':
          return { tasks: event.tasks }
        case 'approvals_changed': {
          // If the currently shown approval peek was resolved, dismiss it cleanly.
          let peek = prev.peek
          if (peek?.message.kind === 'approval' && peek.message.requestId) {
            const stillPending = event.approvals.some((a) => a.requestId === peek!.message.requestId)
            if (!stillPending) peek = null
          }
          return { approvals: event.approvals, peek }
        }
        case 'peek': {
          if (prev.open) return prev
          const extraCount = prev.peek ? prev.peek.extraCount + 1 : 0
          return {
            peek: { message: event.message, extraCount }
          }
        }
        case 'controls_changed':
          return { controls: event.controls }
        case 'permission_changed':
          return { permissionMode: event.mode }
        case 'state_changed':
          return { state: event.state }
        default:
          return prev
      }
    })
  },

  openBot: (originEl) => {
    if (get().open) return
    const origin = elementCenterOrigin(originEl ?? orbAnchorElement)
    runBotRadialReveal('expand', origin, () => {
      set({ open: true, unreadCount: 0, peek: null })
    })
    void api.bot.setSurface('bot').catch((error) => {
      console.error('Could not persist bot surface:', error)
    })
  },

  closeBot: (originEl) => {
    if (!get().open) return
    const origin = elementCenterOrigin(originEl ?? orbAnchorElement)
    runBotRadialReveal('collapse', origin, () => {
      set({ open: false, drawerOpen: false, focusedTaskId: null })
    })
    void api.bot.setSurface('workspace').catch((error) => {
      console.error('Could not persist workspace surface:', error)
    })
  },

  toggleBot: (originEl) => {
    if (get().open) get().closeBot(originEl)
    else get().openBot(originEl)
  },

  setDrawerOpen: (drawerOpen, focusTaskId = null) => {
    set({ drawerOpen, focusedTaskId: drawerOpen ? focusTaskId : null })
  },

  toggleDrawer: () => {
    set((prev) => ({
      drawerOpen: !prev.drawerOpen,
      focusedTaskId: prev.drawerOpen ? null : prev.focusedTaskId
    }))
  },

  dismissPeek: () => set({ peek: null }),

  setDraftInput: (draftInput) => set((prev) => ({ draftInput, draftRevision: prev.draftRevision + 1 })),

  sendMessage: async (input) => {
    try {
      const landed = await api.bot.sendMessage(input)
      set((prev) => ({
        timeline: upsertTimeline(prev.timeline, landed),
        error: null
      }))
    } catch (error) {
      set({ error: failureMessage(error) })
      throw error
    }
  },

  retryLastMessage: async () => {
    try {
      const landed = await api.bot.retryLastMessage()
      if (landed) {
        set((prev) => ({ timeline: upsertTimeline(prev.timeline, landed), error: null }))
      }
    } catch (error) {
      set({ error: failureMessage(error) })
    }
  },

  abortCurrentTurn: async () => {
    await api.bot.abortCurrentTurn().catch((error) => {
      set({ error: failureMessage(error) })
    })
  },

  setPermissionMode: async (mode) => {
    const next = await api.bot.setPermissionMode(mode)
    set({ permissionMode: next })
  },

  setModel: async (provider, id) => {
    const controls = await api.bot.setModel(provider, id)
    if (controls) set({ controls })
  },

  setThinking: async (level) => {
    const controls = await api.bot.setThinking(level)
    if (controls) set({ controls })
  },

  resetContext: async () => {
    const snapshot = await api.bot.resetContext()
    get().applySnapshot(snapshot, false)
  },

  stopTask: async (taskId) => {
    set((prev) => ({ stoppingTaskIds: { ...prev.stoppingTaskIds, [taskId]: true } }))
    try {
      const task = await api.bot.stopTask(taskId)
      set((prev) => {
        const stopping = { ...prev.stoppingTaskIds }
        delete stopping[taskId]
        return { tasks: upsertTask(prev.tasks, task), stoppingTaskIds: stopping }
      })
    } catch (error) {
      set((prev) => {
        const stopping = { ...prev.stoppingTaskIds }
        delete stopping[taskId]
        return { stoppingTaskIds: stopping, error: failureMessage(error) }
      })
      throw error
    }
  },

  takeOverTask: async (taskId) => {
    set((prev) => ({ stoppingTaskIds: { ...prev.stoppingTaskIds, [taskId]: true } }))
    try {
      const task = await api.bot.takeOverTask(taskId)
      set((prev) => {
        const stopping = { ...prev.stoppingTaskIds }
        delete stopping[taskId]
        return { tasks: upsertTask(prev.tasks, task), stoppingTaskIds: stopping }
      })
      return task
    } catch (error) {
      set((prev) => {
        const stopping = { ...prev.stoppingTaskIds }
        delete stopping[taskId]
        return { stoppingTaskIds: stopping, error: failureMessage(error) }
      })
      throw error
    }
  },

  followupTask: async (taskId, instruction) => {
    await api.bot.followupTask(taskId, instruction)
    const tasks = await api.bot.listTasks({ status: 'all' })
    set({ tasks })
  },

  cleanupWorktree: async (taskId, confirmation) => {
    await api.bot.cleanupWorktree(taskId, confirmation)
    const tasks = await api.bot.listTasks({ status: 'all' })
    set({ tasks })
  }
}))
