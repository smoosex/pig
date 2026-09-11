import { useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import type { ProviderAuthType, SettingsProvider } from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem
} from '../ui/dropdown-menu'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { AddProviderDialog } from './AddProviderDialog'
import { AuthDialog } from './AuthDialog'
import { useProviderAuth } from './use-provider-auth'

function sourceLabel(provider: SettingsProvider): string {
  if (!provider.configured) return '未配置'
  if (provider.using === 'oauth') return '已登录'
  if (provider.source === 'environment') return '环境变量'
  if (provider.source === 'stored') return '已保存密钥'
  return '已配置'
}

export function ProvidersPane() {
  const providers = useSettingsStore((s) => s.providers)
  const [adding, setAdding] = useState(false)
  const {
    login,
    lines,
    prompt,
    error,
    busy,
    removing,
    actionError,
    startLogin: loginProvider,
    cancel,
    logout,
    submit
  } = useProviderAuth()
  const openAdd = () => setAdding(true)
  const startLogin = (provider: SettingsProvider, method: ProviderAuthType) => {
    setAdding(false)
    void loginProvider(provider, method)
  }

  const configured = providers.filter((provider) => provider.configured)
  const locked = busy || removing !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">已配置 {configured.length} 个供应商</p>
        <Button size="sm" onClick={openAdd} disabled={locked}>
          <Plus data-icon="inline-start" />
          添加供应商
        </Button>
      </div>
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {configured.length ? (
        <SettingsCard>
          {configured.map((provider) => (
            <SettingsRow
              key={provider.id}
              title={provider.name}
              description={
                provider.using === 'oauth'
                  ? provider.oauth?.subscription
                    ? '订阅账号'
                    : '账号授权'
                  : 'API 密钥'
              }
            >
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{sourceLabel(provider)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={locked}>
                      {removing === provider.id ? '处理中…' : '管理'}
                      <ChevronDown data-icon="inline-end" />
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
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => void logout(provider)}
                        >
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
          <Button variant="outline" onClick={openAdd} disabled={locked}>
            添加供应商
          </Button>
        </Empty>
      )}
      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        providers={providers}
        onConnect={startLogin}
      />
      <AuthDialog
        open={login != null}
        title={
          login ? `${login.method === 'oauth' ? '登录' : '配置'} ${login.provider.name}` : '登录'
        }
        lines={lines}
        prompt={prompt}
        busy={busy}
        error={error}
        onSubmit={submit}
        onCancel={cancel}
      />
    </div>
  )
}
