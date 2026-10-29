/** Quit confirmation: main counts the work a quit would stop, a window's UI asks the user. */
import type { Translate } from './i18n'

export interface QuitActivity {
  sessions: number
  subagents: number
  processes: number
}

/** `dismiss` withdraws an `ask` whose shown-ack came too late; main has asked natively instead. */
export type QuitConfirmRequest =
  | { type: 'ask'; requestId: string; activity: QuitActivity }
  | { type: 'dismiss'; requestId: string }

export interface QuitApi {
  /** Subscribing also tells main this window can show the prompt; until then it is never asked. */
  onQuitConfirm(listener: (request: QuitConfirmRequest) => void): () => void
  /** Sent once the dialog is on screen: proves the UI is responsive, so main stops considering a fallback. */
  ackQuitConfirm(requestId: string): Promise<void>
  replyQuitConfirm(requestId: string, confirmed: boolean): Promise<void>
}

export function describeQuitActivity(activity: QuitActivity, t: Translate): string {
  const items = [
    activity.sessions > 0 && t('quit.sessions', { count: activity.sessions }),
    activity.subagents > 0 && t('quit.subagents', { count: activity.subagents }),
    activity.processes > 0 && t('quit.processes', { count: activity.processes })
  ].filter(Boolean)
  return t('quit.description', { items: items.join(t('quit.separator')) })
}
