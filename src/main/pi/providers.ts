import { randomUUID } from 'node:crypto'
import { shell, type BrowserWindow } from 'electron'
import { currentLocale } from '../i18n'
import { getOrCreateDeviceId, startModelRuntime } from './model-settings'
import { synchronizeModelCatalog } from './model-catalog'

import type {
  ProviderAuthType,
  SettingsAuthEvent,
  SettingsAuthNotify,
  SettingsAuthPrompt,
  SettingsProvider
} from '../../shared/api'

export type {
  ProviderAuthType,
  SettingsAuthEvent,
  SettingsAuthNotify,
  SettingsAuthPrompt,
  SettingsProvider
} from '../../shared/api'

let loginAbort: AbortController | null = null
const promptWaiters = new Map<string, {
  owner: AbortController
  resolve: (value: string) => void
  reject: (error: Error) => void
}>()

function clearPrompts(owner: AbortController, error: Error): void {
  for (const [id, waiter] of promptWaiters) {
    if (waiter.owner !== owner) continue
    promptWaiters.delete(id)
    waiter.reject(error)
  }
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
    .sort((a, b) => a.name.localeCompare(b.name, currentLocale()))
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
      clearPrompts(abort, cancelled)
    },
    { once: true }
  )

  const send = (event: SettingsAuthEvent) => {
    if (abort.signal.aborted || loginAbort !== abort) return
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      abort.abort()
      return
    }
    win.webContents.send('settings:auth-event', event)
  }

  try {
    const runtime = await startModelRuntime()
    abort.signal.throwIfAborted()
    // The SDK callback is synchronous; persist OpenAI's installation ID before entering its flow.
    const deviceId = providerId === 'openai' && authType === 'oauth'
      ? await getOrCreateDeviceId()
      : undefined
    abort.signal.throwIfAborted()
    await runtime.login(providerId, authType, {
      signal: abort.signal,
      prompt: (prompt) => {
        abort.signal.throwIfAborted()
        const id = randomUUID()
        return new Promise<string>((resolve, reject) => {
          promptWaiters.set(id, { owner: abort, resolve, reject })
          send({ kind: 'prompt', id, prompt: serializePrompt(prompt) })
        })
      },
      notify: (event) => {
        if (abort.signal.aborted || loginAbort !== abort) return
        const payload = serializeNotify(event)
        if (!payload) return
        const url = payload.type === 'auth_url' ? payload.url : payload.type === 'device_code' ? payload.verificationUri : undefined
        if (url) void shell.openExternal(url).catch((error) => console.error('Could not open login URL:', error))
        send({ kind: 'notify', event: payload })
      }
    }, deviceId === undefined ? undefined : { getDeviceId: () => deviceId })
    abort.signal.throwIfAborted()
    try {
      await runtime.refresh({ providers: [providerId], signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) })
      abort.signal.throwIfAborted()
    } finally {
      // Login already changed credentials. Publish that snapshot even if the targeted refresh fails.
      synchronizeModelCatalog()
    }
  } catch (error) {
    // Translate cancellation to the auth boundary's result; settings/SDK/refresh failures propagate.
    if (abort.signal.aborted) throw cancelled
    throw error
  } finally {
    if (loginAbort === abort) loginAbort = null
    clearPrompts(abort, cancelled)
  }
}

export async function logoutProvider(providerId: string): Promise<void> {
  const runtime = await startModelRuntime()
  await runtime.logout(providerId, { signal: AbortSignal.timeout(15_000) })
  synchronizeModelCatalog()
}
