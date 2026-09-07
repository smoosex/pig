import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, KeyRound, Palette, Plus, Settings2 } from 'lucide-react'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty'
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from '../ui/command'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem } from '../ui/dropdown-menu'
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
import { useModelNavigation } from '../../hooks/useModelNavigation'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ScrollArea } from '../ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

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
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10 [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/50 [&>*+*]:before:content-['']">
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
  const [open, setOpen] = useState(false)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((item) =>
      `${item.name} ${item.providerName} ${item.provider} ${item.id}`.toLowerCase().includes(q)
    )
  }, [models, query])
  const select = (item: SessionModelInfo) => { onSelect(item); setOpen(false); setQuery('') }
  const navigation = useModelNavigation(filtered, open, select)

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery('') }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="max-w-64 font-normal">
          <span className="truncate">{model?.name ?? '选择模型'}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-1 p-1.5" onKeyDown={navigation.onKeyDown}>
        <Input
          autoFocus
          aria-label="搜索模型"
          value={query}
          placeholder="搜索模型"
          className="h-7 shrink-0 md:text-xs"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-80 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {models.length === 0 ? '没有可用模型' : '没有匹配的模型'}
            </p>
          ) : (
            filtered.map((item, index) => (
              <Button
                key={modelKey(item)}
                type="button"
                variant="ghost"
                ref={navigation.index === index ? navigation.activeRef : undefined}
                className={`h-auto w-full justify-start px-2 py-2 text-left font-normal hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent ${navigation.index === index ? 'bg-accent' : ''}`}
                onPointerMove={() => navigation.hover(index)}
                onClick={() => select(item)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.providerName} · {item.provider}/{item.id}
                  </span>
                </span>
                {model && modelKey(model) === modelKey(item) ? <Check /> : null}
              </Button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
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
              <SelectContent position="popper" align="end">
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
                <SelectContent position="popper" align="end">
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
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={appearance}
              onValueChange={(value) => {
                if (!value) return
                void setTheme({ appearance: value as Appearance })
              }}
            >
              <ToggleGroupItem value="system">系统</ToggleGroupItem>
              <ToggleGroupItem value="light">浅色</ToggleGroupItem>
              <ToggleGroupItem value="dark">暗色</ToggleGroupItem>
            </ToggleGroup>
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
              <SelectContent position="popper" align="end">
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
              <SelectContent position="popper" align="end">
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
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
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
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<SettingsProvider | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const openAdd = () => {
    setQuery('')
    setChosen(null)
    setAdding(true)
  }

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
    setAdding(false)
    setActionError(null)
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
    setRemoving(provider.id)
    setActionError(null)
    try {
      setProviders(await api.logoutProvider(provider.id))
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(null)
    }
  }

  const configured = providers.filter((provider) => provider.configured)
  const available = providers.filter((provider) => provider.oauth || provider.apiKey)
  const locked = busy || removing !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">已配置 {configured.length} 个供应商</p>
        <Button size="sm" onClick={openAdd} disabled={locked}>
          <Plus data-icon="inline-start" />添加供应商
        </Button>
      </div>
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      {configured.length ? (
        <SettingsCard>
          {configured.map((provider) => (
            <SettingsRow
              key={provider.id}
              title={provider.name}
              description={provider.using === 'oauth' ? (provider.oauth?.subscription ? '订阅账号' : '账号授权') : 'API 密钥'}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{sourceLabel(provider)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={locked}>
                      {removing === provider.id ? '处理中…' : '管理'}<ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      {provider.oauth ? (
                        <DropdownMenuItem onSelect={() => void startLogin(provider, 'oauth')}>
                          {provider.using === 'oauth' ? '重新登录' : '登录账号'}
                        </DropdownMenuItem>
                      ) : null}
                      {provider.apiKey?.canLogin ? (
                        <DropdownMenuItem onSelect={() => void startLogin(provider, 'api_key')}>
                          {provider.using === 'api_key' ? '更新密钥' : '设置密钥'}
                        </DropdownMenuItem>
                      ) : null}
                      {provider.using === 'oauth' || provider.source === 'stored' ? (
                        <DropdownMenuItem variant="destructive" onSelect={() => void logout(provider)}>
                          {provider.using === 'oauth' ? '退出登录' : '移除密钥'}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem disabled>凭据由外部配置管理</DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      ) : (
        <Empty className="min-h-60 border">
          <EmptyHeader>
            <EmptyTitle>连接你的第一个供应商</EmptyTitle>
            <EmptyDescription>登录订阅账号或添加 API 密钥，即可使用对应模型。</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={openAdd} disabled={locked}>添加供应商</Button>
        </Empty>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{chosen ? chosen.name : '添加供应商'}</DialogTitle>
            <DialogDescription>{chosen ? '选择连接方式，凭据将交由 pi 管理。' : '搜索供应商，登录账号或配置 API 密钥。'}</DialogDescription>
          </DialogHeader>
          {chosen ? (
            <div className="flex flex-col gap-3">
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setChosen(null)}>
                <ChevronLeft data-icon="inline-start" />返回供应商列表
              </Button>
              {chosen.oauth ? (
                <Button variant="outline" className="h-auto justify-between py-3" onClick={() => void startLogin(chosen, 'oauth')}>
                  <span>{chosen.oauth.subscription ? '订阅登录' : '账号登录'}</span><ChevronRight data-icon="inline-end" />
                </Button>
              ) : null}
              {chosen.apiKey?.canLogin ? (
                <Button variant="outline" className="h-auto justify-between py-3" onClick={() => void startLogin(chosen, 'api_key')}>
                  <span>设置 API 密钥</span><ChevronRight data-icon="inline-end" />
                </Button>
              ) : chosen.apiKey ? (
                <p className="text-sm text-muted-foreground">此供应商需要通过环境变量或外部凭据配置：{chosen.apiKey.name}</p>
              ) : null}
            </div>
          ) : (
            <Command
              loop
              onKeyDownCapture={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
              }}
            >
              <CommandInput aria-label="搜索供应商" placeholder="搜索名称或 ID…" value={query} onValueChange={setQuery} />
              <CommandList className="max-h-80">
                <CommandEmpty>没有匹配的供应商，试试其他名称或关键词。</CommandEmpty>
                {[
                  { heading: '订阅登录', items: available.filter((provider) => provider.oauth) },
                  { heading: 'API 密钥', items: available.filter((provider) => !provider.oauth && provider.apiKey) }
                ].map(({ heading, items }, index) => (
                  <Fragment key={heading}>
                  {index > 0 ? <CommandSeparator /> : null}
                  <CommandGroup heading={heading}>
                    {items.map((provider) => (
                      <CommandItem key={provider.id} value={provider.id} keywords={[provider.name]} className="py-3" onSelect={() => setChosen(provider)}>
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        <span data-slot="command-shortcut" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          {provider.configured ? '已配置' : null}<ChevronRight />
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  </Fragment>
                ))}
              </CommandList>
            </Command>
          )}
        </DialogContent>
      </Dialog>
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
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (document.querySelector('[data-slot=dialog-content], [data-slot=popover-content][data-state=open], [data-slot=select-content][data-state=open], [data-slot=dropdown-menu-content][data-state=open]')) return
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
          className="justify-start font-normal"
          onClick={() => setSection('general')}
        >
          <Settings2 data-icon="inline-start" />
          通用
        </Button>
        <Button
          type="button"
          variant={section === 'theme' ? 'secondary' : 'ghost'}
          className="justify-start font-normal"
          onClick={() => setSection('theme')}
        >
          <Palette data-icon="inline-start" />
          主题
        </Button>
        <Button
          type="button"
          variant={section === 'providers' ? 'secondary' : 'ghost'}
          className="justify-start font-normal"
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
