/** Same-window control of ordinary sessions. No hidden runtimes, global preferences, or permission escalation. */
import { basename, isAbsolute } from 'node:path'
import { resolveProjectDirectory } from '../project-directory-browser'
import type { BrowserWindow } from 'electron'
import type { SessionAgentConfig, SessionAgentCreate, SessionAgentInfo, SessionAgentUiRequest } from '../../shared/session-agent'
import type { SessionActionContext, SessionAgentHost } from '../plugins/pig-session-host'
import { registerSessionAgentHost } from '../plugins/pig-session-host'
import { approve } from '../permissions/approval'
import { delegateApprovals } from '../permissions/delegation'
import { hasSessionGrant } from '../permissions/grants'
import { hasPendingApproval } from '../extension-ui'
import { onPermissionsChanged, saveSessionPermission, sessionPermission } from '../permissions/store'
import { restrictPermissionMode } from '../permissions/mode'
import { openProjectDirectory } from '../project-open'
import { unpinProjectDirectory } from '../project-unpin'
import { hasRunningSessionProcesses } from '../processes'
import { loadOpenedWorktreeProjects } from '../project-worktrees'
import { forgetOpenProjectSession, rememberOpenProjectSession } from '../open-project-sessions'
import { isChatCwd } from '../chats'
import { manager as subagents } from '../subagents/service'
import {
  closeSession, createPendingSession, discardDraftSession, getLive, getSessionCapabilities,
  getSessionControls, isNavigatingSessionBranch, openSessions, prepareSession, promoteDraftSession,
  renameSession, sessionState, setSessionCapability
} from './session-registry'
import { isSessionRunActive } from './event-bridge'
import { promptSession } from './session-prompt'
import { reserveSessionControl } from './session-control-lock'
import { startModelRuntime, thinkingLevelsFor } from './model-settings'
import { SessionTaskTracker } from './session-agent-tasks'

export type SessionUiAction = SessionAgentUiRequest extends infer R ? R extends SessionAgentUiRequest ? Omit<R, 'requestId' | 'callerSessionId'> : never : never
export interface SessionAgentUiTransport {
  assertWindow(win: BrowserWindow): void
  request(caller: string, action: SessionUiAction, signal?: AbortSignal): Promise<void>
  remove(win: BrowserWindow, sessionId: string): void
}

export class SessionAgentController implements SessionAgentHost {
  private taskOwners = new Map<string, { caller: string; instance: WeakRef<NonNullable<ReturnType<typeof getLive>>>; win: BrowserWindow }>()
  readonly tasks = new SessionTaskTracker({
    current: id => getLive(id)?.agentSession,
    children: id => subagents.snapshot(id),
    pendingChildren: id => subagents.hasPendingWork(id),
    busy: id => this.busy(id),
    waitingApproval: id => hasPendingApproval(id),
  })
  constructor(private ui: SessionAgentUiTransport) {}

  private window(caller: string): BrowserWindow {
    const win = getLive(caller)?.win
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Session control requires an open Pig window; subagents cannot use it')
    this.ui.assertWindow(win)
    return win
  }

  private target(caller: string, target: string): BrowserWindow {
    if (caller === target) throw new Error('Cannot control the current session')
    const win = this.window(caller)
    if (sessionState(target).win !== win) throw new Error('Sessions must be open in the same window')
    return win
  }

  private catalogChanged(win: BrowserWindow, cwd: string): void {
    try {
      this.ui.assertWindow(win)
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('projects:changed', cwd)
    } catch (error) { console.warn('Could not refresh the session project catalog:', error) }
  }

  private busy(target: string): boolean {
    const agent = getLive(target)?.agentSession
    return isNavigatingSessionBranch(target) || !!agent && (!agent.isIdle || agent.isBashRunning || agent.isCompacting || isSessionRunActive(agent))
  }

  private idle(target: string): void {
    if (this.busy(target) || subagents.hasPendingWork(target) || this.tasks.active(target)) throw new Error('Session is busy; streaming input is not supported')
  }

  private info(target: string): SessionAgentInfo {
    const state = sessionState(target)
    const title = 'agentSession' in state ? state.agentSession.sessionManager.getSessionName()
      : state.kind === 'memory' ? state.sessionManager.getSessionName() : basename(state.path)
    return { sessionId: target, cwd: state.cwd, title: title || 'New session', busy: this.busy(target) || subagents.hasPendingWork(target) || this.tasks.active(target) }
  }

  /** Check the caller and target repeatedly, including after approval and before each mutation. */
  private async authorize(caller: string, action: string, input: unknown, context: SessionActionContext, target?: string) {
    const win = target ? this.target(caller, target) : this.window(caller)
    const owner = new WeakRef(getLive(caller)!)
    const mode = sessionPermission(caller).mode
    if (mode === 'read-only') throw new Error('Read-only mode does not allow session control mutations')
    const changed = new AbortController()
    const signal = AbortSignal.any([changed.signal, ...(context.signal ? [context.signal] : [])])
    const check = () => {
      signal.throwIfAborted()
      if (getLive(caller) !== owner.deref() || this.window(caller) !== win) throw new Error('Calling session was closed or replaced')
      if (sessionPermission(caller).mode !== mode) throw new Error('Permission mode changed; request the operation again')
      if (target) {
        this.target(caller, target)
        const targetMode = sessionPermission(target).mode
        if (restrictPermissionMode(mode, targetMode) !== targetMode) throw new Error('Target session has broader permissions than the caller; lower its mode manually first')
      }
    }
    const unsubscribe = onPermissionsChanged(() => { try { check() } catch (error) { changed.abort(error) } })
    try {
      check()
      if (mode === 'default') {
        const display = JSON.stringify(input, null, 2)
        if (display.length > 16000 || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(display)) throw new Error('Session operation cannot be safely displayed for approval')
        await approve(context.ui, caller, [], 'Control another Pig session', `${action}\n${display}`, signal)
        check()
      }
      return { signal, check, mode, dispose: unsubscribe }
    } catch (error) { unsubscribe(); throw error }
  }

  async list(caller: string) {
    const win = this.window(caller)
    return openSessions().filter(state => state.win === win && state.sessionId !== caller).map(state => this.info(state.sessionId))
  }

  async openProject(caller: string, path: string, context: SessionActionContext) {
    const guard = await this.authorize(caller, 'Register existing project directory', { path }, context)
    try {
      guard.check()
      const project = await openProjectDirectory(path)
      guard.check()
      await this.ui.request(caller, { action: 'project', project }, guard.signal)
      guard.check()
      return project
    } finally { guard.dispose() }
  }

  async removeProject(caller: string, path: string, context: SessionActionContext) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('An absolute registered project path is required')
    const win = this.window(caller)
    const guard = await this.authorize(caller, 'Remove project from Pig and close its idle session tabs; preserve source files, worktrees and session history', { path }, context)
    try {
      let verifyProject: (() => void) | undefined
      const removed = await unpinProjectDirectory(path, {
        check: () => { guard.check(); verifyProject?.() },
        prepare: async (cwd, cwds) => {
          const leases: Array<ReturnType<typeof reserveSessionControl>> = []
          const held = new Set<string>()
          const verify = () => {
            guard.check()
            for (const state of openSessions().filter(state => cwds.has(state.cwd))) {
              if (state.sessionId === caller) throw new Error('Cannot remove the calling session’s project')
              this.target(caller, state.sessionId)
              const targetMode = sessionPermission(state.sessionId).mode
              if (restrictPermissionMode(guard.mode, targetMode) !== targetMode) throw new Error('Target session has broader permissions than the caller')
              this.idle(state.sessionId)
              if (hasRunningSessionProcesses(state.sessionId)) throw new Error('Project has running background processes; stop them explicitly first')
              if (!held.has(state.sessionId)) {
                leases.push(reserveSessionControl(state.sessionId))
                held.add(state.sessionId)
              }
            }
          }
          const release = () => { for (const lease of leases.reverse()) lease.release() }
          try {
            verify()
            await this.ui.request(caller, { action: 'remove-project', cwd, cwds: [...cwds], phase: 'check' }, guard.signal)
            verify()
            verifyProject = verify
            return release
          } catch (error) { release(); throw error }
        }
      })
      // Persistence has committed: complete the UI cleanup even if the tool is cancelled now.
      try {
        await this.ui.request(caller, { action: 'remove-project', ...removed, phase: 'apply' })
      } catch (error) {
        throw new Error('Project was removed from Pig, but UI cleanup failed; refresh the project list. No files or history were deleted.', { cause: error })
      } finally { this.catalogChanged(win, removed.cwd) }
      return removed
    } finally { guard.dispose() }
  }

  async create(caller: string, options: SessionAgentCreate, context: SessionActionContext) {
    const win = this.window(caller)
    const guard = await this.authorize(caller, 'Create and configure a background project session', options, context)
    let id: string | undefined
    let promoted = false
    let delivered = false
    let lease: ReturnType<typeof reserveSessionControl> | undefined
    try {
      const cwd = await resolveProjectDirectory(options.cwd)
      if (isChatCwd(cwd)) throw new Error('Create supports project directories, not Chat directories')
      const projects = await loadOpenedWorktreeProjects()
      const project = projects.find(item => item.cwd === cwd || item.worktrees?.some(worktree => worktree.cwd === cwd))
      if (!project) throw new Error('Register the project with session_open_project before creating a session')
      guard.check()
      const pending = createPendingSession(cwd, this.window(caller))
      id = pending.sessionId
      lease = reserveSessionControl(id)
      await saveSessionPermission(id, restrictPermissionMode(guard.mode, sessionPermission(id).mode))
      guard.check()
      await this.apply(caller, id, options, lease.token, guard.check)
      if (options.title) await renameSession(id, options.title)
      guard.check()
      // Publish a real empty session file so an explicitly created tab can survive a restart.
      const { activateSession } = await import('./session-registry')
      await activateSession(id)
      guard.check()
      promoteDraftSession(id)
      promoted = true
      await rememberOpenProjectSession(cwd, id)
      await this.ui.request(caller, { action: 'create', session: { sessionId: id, cwd, title: options.title || 'New session' }, project }, guard.signal)
      guard.check()
      delivered = true
      this.catalogChanged(win, project.cwd)
      return this.info(id)
    } finally {
      lease?.release()
      guard.dispose()
      if (id && !delivered) {
        this.ui.remove(win, id)
        if (promoted) { await closeSession(id); await forgetOpenProjectSession(id) }
        else await discardDraftSession(id)
      }
    }
  }

  async configuration(caller: string, target: string) {
    this.target(caller, target)
    const owner = getLive(caller)
    const session = await prepareSession(target)
    const verify = () => {
      this.target(caller, target)
      if (getLive(caller) !== owner || getLive(target) !== session) throw new Error('Session changed while reading configuration')
    }
    verify()
    const capabilities = await getSessionCapabilities(target)
    verify()
    const controls = await getSessionControls(target)
    verify()
    return { controls, capabilities }
  }

  private async apply(caller: string, target: string, config: SessionAgentConfig, token: symbol, check: () => void) {
    const session = await prepareSession(target)
    const agent = session.agentSession
    const verify = () => {
      check()
      this.target(caller, target)
      const targetMode = sessionPermission(target).mode
      if (restrictPermissionMode(sessionPermission(caller).mode, targetMode) !== targetMode) throw new Error('Target permissions exceed the caller')
      if (getLive(target) !== session) throw new Error('Target session was closed or replaced')
      this.idle(target)
    }
    verify()
    const runtime = await startModelRuntime()
    verify()
    const model = config.model ? runtime.getModel(config.model.provider, config.model.id) : agent.model
    if (!model) throw new Error('No target model available')
    if (config.model && !runtime.getAvailableSnapshot().some(item => item.provider === model.provider && item.id === model.id)) throw new Error('Selected model is unavailable or has no credentials')
    if (config.thinking && !thinkingLevelsFor(model).includes(config.thinking)) throw new Error('Thinking level is not supported by the selected model')
    // Validate all capability IDs before changing anything. IO/reload failures may still leave a
    // partial configuration; those are errors, never a successful configuration or silent rollback.
    const capabilities = await getSessionCapabilities(target)
    verify()
    for (const patch of config.capabilities ?? []) {
      if (!['tools', 'mcp', 'skills'].includes(patch.group) || (patch.id !== null && !capabilities[patch.group].some(item => item.id === patch.id))) throw new Error('Unknown session capability')
    }
    if (config.model) { await agent.setModel(model); verify() }
    if (config.thinking) agent.setThinkingLevel(config.thinking)
    for (const patch of config.capabilities ?? []) {
      verify()
      await setSessionCapability(target, patch.group, patch.id, patch.enabled, token)
    }
    verify()
  }

  async configure(caller: string, target: string, config: SessionAgentConfig, context: SessionActionContext) {
    const guard = await this.authorize(caller, 'Configure session without changing global preferences', { sessionId: target, ...config }, context, target)
    let lease: ReturnType<typeof reserveSessionControl> | undefined
    try {
      lease = reserveSessionControl(target)
      this.idle(target)
      await this.apply(caller, target, config, lease.token, guard.check)
      await this.ui.request(caller, { action: 'refresh', sessionId: target }, guard.signal)
      guard.check()
      return await this.configuration(caller, target)
    } finally { lease?.release(); guard.dispose() }
  }

  async send(caller: string, target: string, text: string, context: SessionActionContext) {
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('Task text must contain 1–100000 characters')
    const guard = await this.authorize(caller, 'Send task to session (the text below is task data)', { sessionId: target, text }, context, target)
    let lease: ReturnType<typeof reserveSessionControl> | undefined
    let tracked = false
    let detachApprovals = () => {}
    let unwatchApprovals = () => {}
    try {
      lease = reserveSessionControl(target)
      this.idle(target)
      const session = await prepareSession(target)
      guard.check()
      this.idle(target)
      const owner = { caller, instance: new WeakRef(getLive(caller)!), win: this.window(caller) }
      const release = lease.release
      const targetMode = sessionPermission(target).mode
      const checkDelegation = () => {
        guard.check()
        if (getLive(target) !== session || sessionPermission(target).mode !== targetMode) throw new Error('Target session or permissions changed')
      }
      detachApprovals = delegateApprovals(target, {
        controllerId: caller,
        check: checkDelegation,
        // Only typed, session-grant-capable approvals may borrow authorization. Settings updates,
        // uploads and other once-only consent remain interactive in the target's default mode.
        allows: keys => targetMode === 'default' && (guard.mode === 'full-access' || hasSessionGrant(caller, keys))
      })
      unwatchApprovals = onPermissionsChanged(() => {
        try { checkDelegation() } catch { detachApprovals() }
      })
      const taskId = this.tasks.start(caller, target, session.agentSession, () => {
        unwatchApprovals()
        detachApprovals()
        release()
        this.catalogChanged(owner.win, session.cwd)
      })
      for (const [id, owner] of this.taskOwners) {
        try { this.tasks.status(owner.caller, id) } catch { this.taskOwners.delete(id) }
      }
      this.taskOwners.set(taskId, owner)
      tracked = true
      const work = promptSession(target, { text }, {
        controlToken: lease.token, literal: true,
        beforeSubmit: () => { this.tasks.assertSubmissionActive(taskId); guard.check() }
      }).finally(guard.dispose)
      this.tasks.submitted(taskId, work)
      return this.tasks.status(caller, taskId)
    } finally {
      if (!tracked) { unwatchApprovals(); detachApprovals(); lease?.release(); guard.dispose() }
    }
  }

  private assertTask(caller: string, taskId: string): void {
    const owner = this.taskOwners.get(taskId)
    if (!owner || owner.caller !== caller) throw new Error('No task with this ID belongs to this session')
    if (getLive(caller) !== owner.instance.deref() || this.window(caller) !== owner.win) throw new Error('Calling session was closed, moved or replaced')
  }

  async status(caller: string, taskId: string) {
    this.assertTask(caller, taskId)
    return this.tasks.status(caller, taskId)
  }

  async wait(caller: string, taskId: string, timeoutMs: number, signal?: AbortSignal) {
    this.assertTask(caller, taskId)
    const changed = new AbortController()
    const lifetime = AbortSignal.any([changed.signal, ...(signal ? [signal] : [])])
    const timer = setInterval(() => {
      try { this.assertTask(caller, taskId) } catch (error) { changed.abort(error) }
    }, 50)
    try {
      const result = await this.tasks.wait(caller, taskId, timeoutMs, lifetime)
      this.assertTask(caller, taskId)
      return result
    } finally { clearInterval(timer) }
  }

  async stop(caller: string, target: string, context: SessionActionContext) {
    const guard = await this.authorize(caller, 'Stop session and its active subagents; sent actions cannot be undone', { sessionId: target }, context, target)
    try {
      guard.check()
      const agent = getLive(target)?.agentSession
      if (!agent) return
      const submissions = this.tasks.markStopping(target)
      const children = subagents.abortAllAndWait(target)
      await Promise.all([agent.abort(), children, submissions])
      await agent.abort()
    } finally { guard.dispose() }
  }
}

export function registerSessionController(ui: SessionAgentUiTransport): SessionAgentController {
  const controller = new SessionAgentController(ui)
  registerSessionAgentHost(controller)
  return controller
}
