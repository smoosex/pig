/**
 * Desktop notifications for permission approvals waiting in a session the user is not looking at.
 * Each session shows at most one, for its oldest pending approval: the composer answers approvals in
 * that order too. A notification lives exactly as long as its request; answering it in the app, from
 * the notification's actions or cancelling it retires the notification, and the next one may follow.
 * The body carries only the request title: the detail can hold commands and paths that the lock screen
 * would expose. Without the detail nothing may be allowed from here, so the only action is the request's
 * last option, which always refuses; allowing means opening the session and reading the full request.
 */
import { app, Notification, type BrowserWindow } from 'electron'
import { t } from './i18n'
import { loadPigSettings } from './pig-settings'
import { focusNotifiedSession, isNotificationSessionVisible, onNotificationVisibilityChange } from './completion-visibility'

export interface ApprovalNotice {
  id: string
  title: string
  /** The request's choices; the last one refuses. */
  options: string[]
  sourceTitle?: string
  /** Answers the request; ignored once it has finished. */
  reply(option: string): void
}

interface Shown { id: string; notification: Notification; win: BrowserWindow }
interface Owner { win: BrowserWindow; queue: ApprovalNotice[]; shown?: Shown; refreshing?: Promise<void> }

const owners = new Map<string, Owner>()
const watchedWindows = new WeakSet<BrowserWindow>()
let bounce: { id?: number; win: BrowserWindow } | undefined

// An approval that arrived while its session was in view must still notify once the user looks away.
function rescheduleWindow(win: BrowserWindow): void {
  for (const [sessionId, owner] of owners) if (owner.win === win) schedule(sessionId, owner)
}
onNotificationVisibilityChange(rescheduleWindow)

async function sessionTitle(sessionId: string): Promise<string> {
  const [{ getLive }, { notificationTitle }] = await Promise.all([
    import('./pi/session-registry'),
    import('./pi/session-preview')
  ])
  const live = getLive(sessionId)
  return live ? notificationTitle(live.agentSession) : 'Pig'
}

function attention(win: BrowserWindow): void {
  if (bounce || win.isDestroyed() || win.isFocused()) return
  bounce = { win, id: app.dock?.bounce('informational') }
  if (!app.dock) win.flashFrame(true)
}

function releaseAttention(): void {
  if (!bounce || [...owners.values()].some((owner) => owner.shown || owner.queue.length)) return
  if (bounce.id !== undefined) app.dock?.cancelBounce(bounce.id)
  else if (!bounce.win.isDestroyed()) bounce.win.flashFrame(false)
  bounce = undefined
}

function retireShown(owner: Owner): void {
  const shown = owner.shown
  if (!shown) return
  owner.shown = undefined
  shown.notification.removeAllListeners()
  shown.notification.close()
  releaseAttention()
}

function show(sessionId: string, owner: Owner, notice: ApprovalNotice, title: string): void {
  const { win } = owner
  const request = notice.sourceTitle ? `${notice.sourceTitle} · ${notice.title}` : notice.title
  const refuse = notice.options.at(-1)
  const notification = new Notification({
    title,
    body: [t('notification.approvalPending', { title: request }), owner.queue.length > 1 ? t('notification.approvalMore') : '']
      .filter(Boolean).join('\n'),
    actions: refuse === undefined ? [] : [{ type: 'button' as const, text: refuse }]
  })
  owner.shown = { id: notice.id, notification, win }
  notification.on('failed', (_event, error) => console.error('Could not show approval notification:', error))
  notification.on('click', () => focusNotifiedSession(win, sessionId))
  notification.on('action', () => {
    if (refuse !== undefined) notice.reply(refuse)
  })
  notification.show()
  attention(win)
}

async function refresh(sessionId: string, owner: Owner): Promise<void> {
  const head = owner.queue[0]
  if (!head || owner.shown || !Notification.isSupported()) return
  const { win } = owner
  if (win.isDestroyed() || isNotificationSessionVisible(win, sessionId)) return
  const [settings, title] = await Promise.all([loadPigSettings(), sessionTitle(sessionId)])
  if (!settings.approvalNotifications || owners.get(sessionId) !== owner || owner.queue[0] !== head || owner.shown) return
  if (win.isDestroyed() || win.webContents.isDestroyed() || isNotificationSessionVisible(win, sessionId)) return
  show(sessionId, owner, head, title)
}

function schedule(sessionId: string, owner: Owner): void {
  // Serialised per session so two quick requests cannot both pass the "nothing shown" check.
  const run = (owner.refreshing ?? Promise.resolve()).then(() => refresh(sessionId, owner))
  owner.refreshing = run.catch((error: unknown) => console.error('Could not show approval notification:', error))
}

export function trackApproval(sessionId: string, win: BrowserWindow, notice: ApprovalNotice): void {
  let owner = owners.get(sessionId)
  if (!owner || owner.win !== win) {
    if (owner) retireShown(owner)
    owner = { win, queue: [] }
    owners.set(sessionId, owner)
  }
  owner.queue.push(notice)
  if (!watchedWindows.has(win)) {
    watchedWindows.add(win)
    win.on('blur', () => rescheduleWindow(win))
  }
  schedule(sessionId, owner)
}

export function retireApproval(sessionId: string, id: string): void {
  const owner = owners.get(sessionId)
  if (!owner) return
  owner.queue = owner.queue.filter((notice) => notice.id !== id)
  if (owner.shown?.id === id) retireShown(owner)
  if (!owner.queue.length) owners.delete(sessionId)
  else schedule(sessionId, owner)
}
