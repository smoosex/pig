import { randomUUID } from 'node:crypto'
import { shell, type BrowserWindow } from 'electron'
import { startModelRuntime } from './session-registry'

export type ProviderAuthType = 'oauth' | 'api_key'

export interface SettingsProvider {
  id: string
  name: string
  oauth: { name: string; loginLabel?: string; subscription: boolean } | null
  apiKey: { name: string; canLogin: boolean } | null
  configured: boolean
  using: ProviderAuthType | null
  source?: string
}

export type SettingsAuthPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: { id: string; label: string; description?: string }[]
    }

export type SettingsAuthNotify =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string }

export type SettingsAuthEvent =
  | { kind: 'prompt'; id: string; prompt: SettingsAuthPrompt }
  | { kind: 'notify'; event: SettingsAuthNotify }

let loginAbort: AbortController | null = null
const promptWaiters = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()

function clearPrompts(error: Error): void {
  for (const waiter of promptWaiters.values()) waiter.reject(error)
  promptWaiters.clear()
}

export async function listProviders(): Promise<SettingsProvider[]> {
  const runtime = await startModelRuntime()
  return runtime
    .getProviders()
    .map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id)
      const oauth = provider.auth.oauth
      const apiKey = provider.auth.apiKey
      return {
        id: provider.id,
        name: provider.name,
        oauth: oauth
          ? {
              name: oauth.name,
              loginLabel: oauth.loginLabel,
              subscription: Boolean(oauth.isSubscription)
            }
          : null,
        apiKey: apiKey
          ? {
              name: apiKey.name,
              canLogin: typeof apiKey.login === 'function'
            }
          : null,
        configured: status.configured,
        using: status.configured
          ? runtime.isUsingOAuth(provider.id)
            ? ('oauth' as const)
            : ('api_key' as const)
          : null,
        source: status.label ?? status.source
      }
    })
    .filter((provider) => provider.oauth || provider.apiKey)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export function cancelProviderLogin(): void {
  loginAbort?.abort()
}

export function resolveAuthPrompt(id: string, value: string | null): void {
  const waiter = promptWaiters.get(id)
  if (!waiter) return
  promptWaiters.delete(id)
  if (value == null || value === '') waiter.reject(new Error('Login cancelled'))
  else waiter.resolve(value)
}

function serializePrompt(prompt: {
  type: string
  message: string
  placeholder?: string
  options?: readonly { id: string; label: string; description?: string }[]
}): SettingsAuthPrompt {
  if (prompt.type === 'select') {
    return {
      type: 'select',
      message: prompt.message,
      options: (prompt.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description
      }))
    }
  }
  if (prompt.type === 'secret' || prompt.type === 'manual_code') {
    return { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder }
  }
  return { type: 'text', message: prompt.message, placeholder: prompt.placeholder }
}

function serializeNotify(event: {
  type: string
  message?: string
  links?: readonly { url: string; label?: string }[]
  url?: string
  instructions?: string
  userCode?: string
  verificationUri?: string
  expiresInSeconds?: number
}): SettingsAuthNotify | null {
  if (event.type === 'info' && event.message) {
    return {
      type: 'info',
      message: event.message,
      links: event.links?.map((link) => ({ url: link.url, label: link.label }))
    }
  }
  if (event.type === 'auth_url' && event.url) {
    return { type: 'auth_url', url: event.url, instructions: event.instructions }
  }
  if (event.type === 'device_code' && event.userCode && event.verificationUri) {
    return {
      type: 'device_code',
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      expiresInSeconds: event.expiresInSeconds
    }
  }
  if (event.type === 'progress' && event.message) {
    return { type: 'progress', message: event.message }
  }
  return null
}

export async function loginProvider(
  win: BrowserWindow,
  providerId: string,
  authType: ProviderAuthType
): Promise<void> {
  if (authType !== 'oauth' && authType !== 'api_key') {
    throw new Error(`Invalid auth type: ${authType}`)
  }
  cancelProviderLogin()
  const abort = new AbortController()
  loginAbort = abort
  const cancelled = new Error('Login cancelled')
  abort.signal.addEventListener(
    'abort',
    () => {
      clearPrompts(cancelled)
    },
    { once: true }
  )

  const send = (event: SettingsAuthEvent) => {
    if (!win.isDestroyed()) win.webContents.send('settings:auth-event', event)
  }

  try {
    const runtime = await startModelRuntime()
    await runtime.login(providerId, authType, {
      signal: abort.signal,
      prompt: (prompt) => {
        abort.signal.throwIfAborted()
        const id = randomUUID()
        send({ kind: 'prompt', id, prompt: serializePrompt(prompt) })
        return new Promise<string>((resolve, reject) => {
          promptWaiters.set(id, { resolve, reject })
        })
      },
      notify: (event) => {
        const payload = serializeNotify(event)
        if (!payload) return
        if (payload.type === 'auth_url') void shell.openExternal(payload.url)
        if (payload.type === 'device_code') void shell.openExternal(payload.verificationUri)
        send({ kind: 'notify', event: payload })
      }
    })
    abort.signal.throwIfAborted()
    await runtime.refresh({ providers: [providerId], signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    if (abort.signal.aborted) throw cancelled
    throw error
  } finally {
    if (loginAbort === abort) loginAbort = null
    clearPrompts(cancelled)
  }
}

export async function logoutProvider(providerId: string): Promise<void> {
  const runtime = await startModelRuntime()
  await runtime.logout(providerId, { signal: AbortSignal.timeout(15_000) })
}
