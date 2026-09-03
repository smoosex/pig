import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, KeyRound, Palette, Settings2 } from 'lucide-react'
import {
  api,
  type Appearance,
  type PaletteId,
  type ProviderAuthType,
  type SendShortcut,
  type SessionModelInfo,
  type SettingsAuthEvent,
  type SettingsAuthNotify,
  type SettingsAuthPrompt,
  type SettingsProvider,
  type ThinkingLevel
} from '../../ipc/api'
import { modelKey, useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { ScrollArea } from '../ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'

function SettingsRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-6 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10">
      {children}
    </div>
  )
}

function DefaultModelPicker({
  model,
  models,
  onSelect
}: {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  onSelect: (model: SessionModelInfo) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((item) =>
      `${item.name} ${item.providerName} ${item.provider} ${item.id}`.toLowerCase().includes(q)
    )
  }, [models, query])

  return (
    <Select
      value={model ? modelKey(model) : ''}
      onValueChange={(value) => {
        const next = models.find((item) => modelKey(item) === value)
        if (next) onSelect(next)
      }}
    >
      <SelectTrigger size="sm" className="max-w-64">
        <SelectValue placeholder="选择模型">
          {model?.name ?? '选择模型'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" position="popper" className="w-80">
        <div className="p-1">
          <Input
            value={query}
            placeholder="搜索模型"
            className="h-7 md:text-xs"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <SelectGroup>
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {models.length === 0 ? '没有可用模型' : '没有匹配的模型'}
            </p>
          ) : (
            filtered.map((item) => (
              <SelectItem key={modelKey(item)} value={modelKey(item)}>
                <span className="flex min-w-0 flex-col">
                  <span>{item.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.providerName} · {item.provider}/{item.id}
                  </span>
                </span>
              </SelectItem>
            ))
          )}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function GeneralPane() {
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const defaultThinkingLevel = useSettingsStore((s) => s.defaultThinkingLevel)
  const thinkingLevels = useSettingsStore((s) => s.thinkingLevels)
  const models = useSettingsStore((s) => s.models)
  const setSendShortcut = useSettingsStore((s) => s.setSendShortcut)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)
  const setDefaultThinking = useSettingsStore((s) => s.setDefaultThinking)
  const newline = sendShortcut === 'enter' ? 'Shift+Enter' : 'Enter'

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          发送
        </p>
        <SettingsCard>
          <SettingsRow title="发送快捷键" description={`${newline} 换行`}>
            <Select
              value={sendShortcut}
              onValueChange={(value) => void setSendShortcut(value as SendShortcut)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="enter">Enter</SelectItem>
                  <SelectItem value="shift-enter">Shift+Enter</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          模型
        </p>
        <SettingsCard>
          <SettingsRow title="默认模型" description="新建对话时使用的模型">
            <DefaultModelPicker
              model={defaultModel}
              models={models}
              onSelect={(item) => void setDefaultModel(item.provider, item.id)}
            />
          </SettingsRow>
          <SettingsRow title="默认思考强度" description="新建对话时使用的推理强度">
            {thinkingLevels.length === 0 ? (
              <span className="text-xs text-muted-foreground">当前模型不支持</span>
            ) : (
              <Select
                value={defaultThinkingLevel ?? thinkingLevels[0]}
                onValueChange={(value) => void setDefaultThinking(value as ThinkingLevel)}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {thinkingLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {thinkingLabels[level]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  )
}

function ThemePane() {
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          外观
        </p>
        <SettingsCard>
          <SettingsRow title="外观" description="跟随系统，或固定浅色 / 暗色">
            <Select
              value={appearance}
              onValueChange={(value) => void setTheme({ appearance: value as Appearance })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="system">系统</SelectItem>
                  <SelectItem value="light">浅色</SelectItem>
                  <SelectItem value="dark">暗色</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          主题
        </p>
        <SettingsCard>
          <SettingsRow title="浅色主题" description="浅色外观时使用的配色">
            <Select
              value={lightTheme}
              onValueChange={(value) => void setTheme({ lightTheme: value as PaletteId })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="pig">默认</SelectItem>
                  <SelectItem value="everforest">Everforest</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow title="暗色主题" description="暗色外观时使用的配色">
            <Select
              value={darkTheme}
              onValueChange={(value) => void setTheme({ darkTheme: value as PaletteId })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="pig">默认</SelectItem>
                  <SelectItem value="everforest">Everforest</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  )
}

function sourceLabel(provider: SettingsProvider): string {
  if (!provider.configured) return '未配置'
  if (provider.using === 'oauth') return '已登录'
  if (provider.source === 'environment') return '环境变量'
  if (provider.source === 'stored') return '已保存密钥'
  return '已配置'
}

function AuthDialog({
  open,
  title,
  lines,
  prompt,
  busy,
  error,
  onSubmit,
  onCancel
}: {
  open: boolean
  title: string
  lines: string[]
  prompt: (SettingsAuthPrompt & { id: string }) | null
  busy: boolean
  error: string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt?.id])

  const secret = prompt?.type === 'secret'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onCancel()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{prompt?.message ?? '按提示完成登录，或取消。'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          {lines.map((line, i) => (
            <p key={i} className="text-sm break-all text-muted-foreground">
              {line}
            </p>
          ))}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {prompt?.type === 'select' ? (
            <div className="flex flex-col gap-1">
              {prompt.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  className="h-auto justify-start py-2"
                  onClick={() => onSubmit(option.id)}
                >
                  <span className="flex min-w-0 flex-col text-left">
                    <span>{option.label}</span>
                    {option.description ? (
                      <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </div>
          ) : prompt ? (
            <Input
              autoFocus
              type={secret ? 'password' : 'text'}
              value={value}
              placeholder={prompt.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onSubmit(value)
                }
              }}
            />
          ) : busy ? (
            <p className="text-sm text-muted-foreground">等待供应商响应…</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          {prompt && prompt.type !== 'select' ? (
            <Button type="button" disabled={!value.trim()} onClick={() => onSubmit(value)}>
              继续
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProviderRow({
  provider,
  method,
  onLogin,
  onLogout
}: {
  provider: SettingsProvider
  method: ProviderAuthType
  onLogin: (provider: SettingsProvider, method: ProviderAuthType) => void
  onLogout: (provider: SettingsProvider) => void
}) {
  const active = provider.configured && provider.using === method
  const canLogin = method === 'oauth' || Boolean(provider.apiKey?.canLogin)
  const label = method === 'oauth' ? provider.oauth?.loginLabel || '登录' : '设置密钥'
  return (
    <SettingsRow
      title={provider.name}
      description={
        method === 'oauth'
          ? provider.oauth?.name ?? '订阅登录'
          : provider.apiKey?.name ?? 'API 密钥'
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{active ? sourceLabel(provider) : '未配置'}</span>
        {active ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onLogout(provider)}>
            {method === 'oauth' ? '退出' : '移除'}
          </Button>
        ) : canLogin ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onLogin(provider, method)}>
            {label}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">环境变量</span>
        )}
      </div>
    </SettingsRow>
  )
}

function ProvidersPane() {
  const providers = useSettingsStore((s) => s.providers)
  const setProviders = useSettingsStore((s) => s.setProviders)
  const load = useSettingsStore((s) => s.load)
  const [login, setLogin] = useState<{
    provider: SettingsProvider
    method: ProviderAuthType
  } | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [prompt, setPrompt] = useState<(SettingsAuthPrompt & { id: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return api.onAuthEvent((event: SettingsAuthEvent) => {
      if (event.kind === 'notify') {
        const text = notifyText(event.event)
        if (text) setLines((current) => [...current, text])
        return
      }
      setPrompt({ ...event.prompt, id: event.id })
    })
  }, [])

  const startLogin = async (provider: SettingsProvider, method: ProviderAuthType) => {
    setLogin({ provider, method })
    setLines([])
    setPrompt(null)
    setError(null)
    setBusy(true)
    try {
      const next = await api.loginProvider(provider.id, method)
      setProviders(next)
      await load()
      setLogin(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'Login cancelled') {
        setLogin(null)
        return
      }
      setError(message)
    } finally {
      setBusy(false)
      setPrompt(null)
    }
  }

  const cancel = () => {
    void api.cancelLogin()
    void api.replyAuthPrompt(prompt?.id ?? '', null)
    setLogin(null)
    setPrompt(null)
    setError(null)
  }

  const logout = async (provider: SettingsProvider) => {
    setProviders(await api.logoutProvider(provider.id))
    await load()
  }

  const oauth = providers.filter((provider) => provider.oauth)
  const keys = providers.filter((provider) => provider.apiKey)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          订阅
        </p>
        <SettingsCard>
          {oauth.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">没有可登录的订阅供应商</p>
          ) : (
            oauth.map((provider) => (
              <ProviderRow
                key={`oauth-${provider.id}`}
                provider={provider}
                method="oauth"
                onLogin={(item, method) => void startLogin(item, method)}
                onLogout={(item) => void logout(item)}
              />
            ))
          )}
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          API 密钥
        </p>
        <SettingsCard>
          {keys.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">没有可配置的密钥供应商</p>
          ) : (
            keys.map((provider) => (
              <ProviderRow
                key={`key-${provider.id}`}
                provider={provider}
                method="api_key"
                onLogin={(item, method) => void startLogin(item, method)}
                onLogout={(item) => void logout(item)}
              />
            ))
          )}
        </SettingsCard>
      </div>
      <AuthDialog
        open={login != null}
        title={login ? `${login.method === 'oauth' ? '登录' : '配置'} ${login.provider.name}` : '登录'}
        lines={lines}
        prompt={prompt}
        busy={busy}
        error={error}
        onSubmit={(value) => {
          if (!prompt) return
          void api.replyAuthPrompt(prompt.id, value)
          setPrompt(null)
        }}
        onCancel={cancel}
      />
    </div>
  )
}

function notifyText(event: SettingsAuthNotify): string | null {
  if (event.type === 'info') return event.message
  if (event.type === 'auth_url') {
    return event.instructions ? `已打开浏览器：${event.url}\n${event.instructions}` : `已打开浏览器：${event.url}`
  }
  if (event.type === 'device_code') return `在 ${event.verificationUri} 输入代码 ${event.userCode}`
  if (event.type === 'progress') return event.message
  return null
}

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<'general' | 'theme' | 'providers'>('general')
  const load = useSettingsStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[data-slot=dialog-content]')) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-62 shrink-0 flex-col gap-1 pr-2 pl-2">
        <div className="flex items-center gap-2 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <ChevronLeft data-icon="inline-start" />
            返回
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={onClose}>
            esc
          </Button>
        </div>
        <Button
          type="button"
          variant={section === 'general' ? 'secondary' : 'ghost'}
          className="justify-start"
          onClick={() => setSection('general')}
        >
          <Settings2 data-icon="inline-start" />
          通用
        </Button>
        <Button
          type="button"
          variant={section === 'theme' ? 'secondary' : 'ghost'}
          className="justify-start"
          onClick={() => setSection('theme')}
        >
          <Palette data-icon="inline-start" />
          主题
        </Button>
        <Button
          type="button"
          variant={section === 'providers' ? 'secondary' : 'ghost'}
          className="justify-start"
          onClick={() => setSection('providers')}
        >
          <KeyRound data-icon="inline-start" />
          供应商
        </Button>
      </nav>
      <div className="m-2 min-w-0 flex-1 overflow-hidden rounded-xl bg-card">
        <ScrollArea className="h-full [&>[data-slot=scroll-area-scrollbar]]:hidden">
          <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-8">
            <div className="flex items-start gap-2">
              {section === 'general' ? (
                <Settings2 className="mt-0.5" />
              ) : section === 'theme' ? (
                <Palette className="mt-0.5" />
              ) : (
                <KeyRound className="mt-0.5" />
              )}
              <div>
                <h1 className="text-lg font-medium">
                  {section === 'general' ? '通用' : section === 'theme' ? '主题' : '供应商'}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {section === 'general'
                    ? '核心行为和快捷键'
                    : section === 'theme'
                      ? '外观和配色'
                      : '登录订阅账号，或保存 API 密钥'}
                </p>
              </div>
            </div>
            <div className={section === 'general' ? 'contents' : 'hidden'}>
              <GeneralPane />
            </div>
            <div className={section === 'theme' ? 'contents' : 'hidden'}>
              <ThemePane />
            </div>
            <div className={section === 'providers' ? 'contents' : 'hidden'}>
              <ProvidersPane />
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
