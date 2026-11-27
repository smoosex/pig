/**
 * Execution-time permission and one-shot approval gate for built-in persona document tools
 * (`persona_soul` and `persona_user`): full-access runs directly, default asks every time with
 * the validated change preview, and read-only refuses without asking.
 */
import type { ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { PersonaFileName } from '../../shared/persona'
import type { PermissionMode } from '../../shared/permissions'
import { t } from '../i18n'
import { runtimePermissionMode } from '../pi/managed-overlay'
import { approve } from './approval'
import { approvalDelegation, onApprovalDelegationEnded } from './delegation'
import { onPermissionsChanged } from './store'

export interface PersonaPermissionOptions {
  sessionId?: string
  mode?: () => PermissionMode
  approvalUI?: Pick<ExtensionUIContext, 'select'>
  signal?: AbortSignal
}

const UNSAFE_DISPLAY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u
const MAX_APPROVAL_DISPLAY_CHARS = 16_000

export function assertSafePersonaApprovalDisplay(patch: string): void {
  if (UNSAFE_DISPLAY_CONTROLS.test(patch)) {
    throw new Error('Persona update contains control characters that cannot be safely displayed for approval')
  }
  if (patch.length > MAX_APPROVAL_DISPLAY_CHARS) {
    throw new Error('Persona update is too large to display for approval; split it into smaller edits')
  }
}

function waitForApproval<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    work.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}

export interface PersonaMutationGuard {
  mode: PermissionMode
  signal: AbortSignal
  check(): void
  requestApproval(file: PersonaFileName, action: string, patch: string): Promise<void>
  dispose(): void
}

export function openPersonaMutationGuard(
  ctx: ExtensionContext,
  options?: PersonaPermissionOptions,
  upstream?: AbortSignal
): PersonaMutationGuard {
  const sessionId = options?.sessionId ?? ctx.sessionManager.getSessionId()
  const readMode = options?.mode ?? (() => runtimePermissionMode(sessionId))
  const delegated = approvalDelegation(sessionId)
  const mode = readMode()
  const changed = new AbortController()
  const signals = [upstream, options?.signal, changed.signal].filter((s): s is AbortSignal => s !== undefined)
  const signal = AbortSignal.any(signals)

  const verify = () => {
    delegated?.check()
    if (readMode() !== mode) {
      throw new Error('Permission mode changed; request the persona update again')
    }
  }
  const unwatchPermissions = onPermissionsChanged(() => {
    try { verify() } catch (error) { changed.abort(error) }
  })
  const unwatchDelegation = onApprovalDelegationEnded((endedSessionId) => {
    if (endedSessionId !== sessionId) return
    try { verify() } catch (error) { changed.abort(error) }
  })
  const dispose = () => {
    unwatchPermissions()
    unwatchDelegation()
  }

  try {
    signal.throwIfAborted()
    verify()
  } catch (error) {
    dispose()
    throw error
  }

  const check = () => {
    signal.throwIfAborted()
    verify()
  }

  return {
    mode,
    signal,
    check,
    async requestApproval(file, action, patch) {
      check()
      if (mode === 'read-only') {
        throw new Error('Read-only mode does not allow persona document updates. Do not retry with another tool.')
      }
      if (mode === 'full-access') return
      assertSafePersonaApprovalDisplay(patch)
      const ui = options?.approvalUI ?? (ctx.hasUI ? ctx.ui : undefined)
      await waitForApproval(
        approve(
          ui,
          sessionId,
          [],
          t('permissions.personaTitle'),
          t('permissions.personaMessage', { file, action, patch }),
          signal
        ),
        signal
      )
      check()
    },
    dispose
  }
}
