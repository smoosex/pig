import { useEffect, useRef, useState } from 'react'
import {
  api,
  type ProviderAuthType,
  type SettingsAuthNotify,
  type SettingsAuthPrompt,
  type SettingsProvider
} from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'

type AuthPrompt = SettingsAuthPrompt & { id: string }
type ProviderOperation = { kind: 'login' | 'logout'; cancelled: boolean }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns one provider operation and its prompts. Cancellation keeps that operation
 * reserved until main settles, so its final events cannot reach a later login.
 */
export function useProviderAuth() {
  const setProviders = useSettingsStore((s) => s.setProviders)
  const load = useSettingsStore((s) => s.load)
  const operation = useRef<ProviderOperation | null>(null)
  const mounted = useRef(false)
  const activePrompt = useRef<AuthPrompt | null>(null)
  const [login, setLogin] = useState<{
    provider: SettingsProvider
    method: ProviderAuthType
  } | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [prompt, setPrompt] = useState<AuthPrompt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const updatePrompt = (next: AuthPrompt | null) => {
    activePrompt.current = next
    setPrompt(next)
  }
  const isCurrent = (request: ProviderOperation) =>
    mounted.current && operation.current === request && !request.cancelled

  useEffect(() => {
    mounted.current = true
    const unsubscribe = api.onAuthEvent((event) => {
      const request = operation.current
      if (request?.kind !== 'login' || request.cancelled) return
      if (event.kind === 'notify') {
        const text = notifyText(event.event)
        if (text) setLines((current) => [...current, text])
      } else {
        updatePrompt({ ...event.prompt, id: event.id })
      }
    })
    return () => {
      mounted.current = false
      unsubscribe()
      const request = operation.current
      operation.current = null
      activePrompt.current = null
      if (request?.kind === 'login' && !request.cancelled) {
        request.cancelled = true
        void api.cancelLogin().catch(() => {})
      }
    }
  }, [])

  const startLogin = async (provider: SettingsProvider, method: ProviderAuthType) => {
    if (operation.current) return
    const request: ProviderOperation = { kind: 'login', cancelled: false }
    operation.current = request
    setActionError(null)
    setLogin({ provider, method })
    setLines([])
    updatePrompt(null)
    setError(null)
    setBusy(true)
    try {
      const next = await api.loginProvider(provider.id, method)
      if (!isCurrent(request)) return
      setProviders(next)
      await load()
      if (isCurrent(request)) setLogin(null)
    } catch (error) {
      if (!isCurrent(request)) return
      const message = errorMessage(error)
      if (message === 'Login cancelled') setLogin(null)
      else setError(message)
    } finally {
      if (operation.current === request) {
        operation.current = null
        setBusy(false)
        updatePrompt(null)
      }
    }
  }

  const cancel = () => {
    const request = operation.current
    if (request?.kind === 'login' && !request.cancelled) {
      request.cancelled = true
      void api.cancelLogin().catch((error) => {
        if (mounted.current && operation.current === request) setActionError(errorMessage(error))
      })
    }
    setLogin(null)
    updatePrompt(null)
    setError(null)
  }

  const logout = async (provider: SettingsProvider) => {
    if (operation.current) return
    const request: ProviderOperation = { kind: 'logout', cancelled: false }
    operation.current = request
    setRemoving(provider.id)
    setActionError(null)
    try {
      const next = await api.logoutProvider(provider.id)
      if (!isCurrent(request)) return
      setProviders(next)
      await load()
    } catch (error) {
      if (isCurrent(request)) setActionError(errorMessage(error))
    } finally {
      if (operation.current === request) {
        operation.current = null
        setRemoving(null)
      }
    }
  }

  const submit = (value: string) => {
    const request = operation.current
    const currentPrompt = activePrompt.current
    if (!request || request.cancelled || !currentPrompt) return
    updatePrompt(null)
    setError(null)
    void api.replyAuthPrompt(currentPrompt.id, value).catch((error) => {
      if (isCurrent(request)) setError(errorMessage(error))
    })
  }

  return {
    login,
    lines,
    prompt,
    error,
    busy,
    removing,
    actionError,
    startLogin,
    cancel,
    logout,
    submit
  }
}

function notifyText(event: SettingsAuthNotify): string | null {
  if (event.type === 'info') return event.message
  if (event.type === 'auth_url') {
    return event.instructions
      ? `已打开浏览器：${event.url}\n${event.instructions}`
      : `已打开浏览器：${event.url}`
  }
  if (event.type === 'device_code') return `在 ${event.verificationUri} 输入代码 ${event.userCode}`
  if (event.type === 'progress') return event.message
  return null
}
