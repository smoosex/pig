/** Host approvals are owned by the requesting session, never by srt's process-global proxy callback. */
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { isPermissionDomain } from '../../shared/permissions'
import { t } from '../i18n'
import { allowSessionHost } from '../sandbox/service'
import { updatePermissionSettings } from './store'
import { grantSession, hasSessionGrant } from './grants'

/** Pig's extension UI renders a select carrying this option inline above the session's composer. */
export interface ApprovalOptions { signal?: AbortSignal; approval: { message: string } }

const ask = (ui: Pick<ExtensionUIContext, 'select'>, title: string, choices: string[], message: string, signal?: AbortSignal) =>
  ui.select(title, choices, { signal, approval: { message } } as ApprovalOptions)

/**
 * Asks once / for this session / deny, unless an earlier session answer covers one of `keys`. The
 * first key is what an answer for the session records. Throws unless the operation may proceed.
 */
export async function approve(ui: Pick<ExtensionUIContext, 'select'> | undefined, sessionId: string, keys: readonly string[], title: string, message: string, signal?: AbortSignal): Promise<void> {
  if (hasSessionGrant(sessionId, keys)) return
  signal?.throwIfAborted()
  if (!ui) throw new Error('This session cannot ask the user, so the operation was refused')
  const once = t('permissions.allowOnce')
  const session = t('permissions.allowSession')
  const answer = await ask(ui, title, [once, session, t('permissions.deny')], message, signal)
  signal?.throwIfAborted()
  if (answer === session) grantSession(sessionId, keys[0]!)
  else if (answer !== once) {
    throw new Error(answer === undefined ? 'The approval request was cancelled; nothing was allowed' : 'The user did not allow this operation. Do not retry it.')
  }
}

export async function offerHosts(ui: Pick<ExtensionUIContext, 'select'> | undefined, sessionId: string, hosts: string[], project: string | null, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  hosts = hosts.filter(isPermissionDomain)
  if (!hosts.length) return ''
  if (!ui) return `\nThe sandbox refused ${hosts.join(', ')}; this session cannot ask the user to allow it.`
  const session = t('permissions.hostsSession')
  const persistent = t('permissions.hostsProject')
  const choices = [session, ...(project ? [persistent] : []), t('permissions.hostsDeny')]
  const answer = await ask(ui, t('permissions.hostsTitle', { hosts: hosts.join(', ') }), choices, t('permissions.hostsMessage'), signal)
  signal?.throwIfAborted()
  if (answer === session) for (const host of hosts) allowSessionHost(sessionId, host)
  else if (answer === persistent && project) {
    await updatePermissionSettings((current) => {
      signal?.throwIfAborted()
      const existing = current.projects.find((entry) => entry.root === project)
      const domains = [...new Set([...(existing?.domains ?? []), ...hosts])]
      return { ...current, projects: [...current.projects.filter((entry) => entry !== existing), { root: project, domains }] }
    })
  } else if (answer === choices[choices.length - 1]) {
    return `\nThe user did not allow ${hosts.join(', ')}. Do not retry it.`
  } else return `\nApproval for ${hosts.join(', ')} was cancelled; no permission was granted.`
  return `\nThe user allowed ${hosts.join(', ')}. Rerun the command if it still needs that host; Pig did not rerun it.`
}
