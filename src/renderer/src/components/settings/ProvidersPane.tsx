import { useState } from 'react'
import type { Translate } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
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

function sourceLabel(t: Translate, provider: SettingsProvider): string {
  if (!provider.configured) return t('providers.notConfigured')
  if (provider.using === 'oauth') return t('providers.signedIn')
  if (provider.source === 'environment') return t('providers.environment')
  if (provider.source === 'stored') return t('providers.storedKey')
  return t('providers.configured')
}

export function ProvidersPane() {
  const t = useT()
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
        <p className="text-sm text-muted-foreground">{t('providers.configuredCount', { count: configured.length })}</p>
        <Button size="sm" onClick={openAdd} disabled={locked}>
          <Plus data-icon="inline-start" />
          {t('providers.add')}
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
                    ? t('providers.subscriptionAccount')
                    : t('providers.accountGrant')
                  : t('providers.apiKey')
              }
            >
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{sourceLabel(t, provider)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={locked}>
                      {removing === provider.id ? t('providers.working') : t('providers.manage')}
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      {provider.oauth ? (
                        <DropdownMenuItem onSelect={() => void startLogin(provider, 'oauth')}>
                          {provider.using === 'oauth' ? t('providers.signInAgain') : t('providers.signIn')}
                        </DropdownMenuItem>
                      ) : null}
                      {provider.apiKey?.canLogin ? (
                        <DropdownMenuItem onSelect={() => void startLogin(provider, 'api_key')}>
                          {provider.using === 'api_key' ? t('providers.updateKey') : t('providers.setKey')}
                        </DropdownMenuItem>
                      ) : null}
                      {provider.using === 'oauth' || provider.source === 'stored' ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => void logout(provider)}
                        >
                          {provider.using === 'oauth' ? t('providers.signOut') : t('providers.removeKey')}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem disabled>{t('providers.externalCredentials')}</DropdownMenuItem>
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
            <EmptyTitle>{t('providers.connectFirst')}</EmptyTitle>
            <EmptyDescription>{t('providers.connectFirstDescription')}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={openAdd} disabled={locked}>
            {t('providers.add')}
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
          login
            ? login.method === 'oauth'
              ? t('providers.authLogin', { name: login.provider.name })
              : t('providers.authConfigure', { name: login.provider.name })
            : t('providers.authFallback')
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
