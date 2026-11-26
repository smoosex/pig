import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, Radar, RotateCw, Settings, Trash2 } from 'lucide-react'
import {
  api,
  type CustomModelInput,
  type CustomModelsState,
  type CustomModelView,
  type CustomProviderInput,
  type CustomProviderView
} from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription } from '../ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { CustomModelDialog } from './CustomModelDialog'
import { CustomProviderDialog } from './CustomProviderDialog'
import { DiscoverModelsDialog, formatModelTokens } from './DiscoverModelsDialog'

export function CustomProvidersSection({ disabled = false }: { disabled?: boolean }) {
  const t = useT()
  const [state, setState] = useState<CustomModelsState>({
    providers: [],
    error: null,
    runtimeError: null
  })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [providerDialog, setProviderDialog] = useState<{ open: boolean; provider?: CustomProviderView }>({
    open: false
  })
  const [modelDialog, setModelDialog] = useState<{
    provider: CustomProviderView
    model?: CustomModelView
  } | null>(null)
  const [discoverProvider, setDiscoverProvider] = useState<CustomProviderView | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<CustomProviderView | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await api.getCustomModels()
      setState(next)
      setActionError(null)
    } catch (err) {
      setActionError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const locked = disabled || busy
  const configBlocked = state.error !== null

  const protocolBadgeLabel = (protocol: string): string => {
    switch (protocol) {
      case 'openai-completions':
        return 'OpenAI'
      case 'openai-responses':
        return 'Responses'
      case 'anthropic-messages':
        return 'Anthropic'
      case 'google-generative-ai':
        return 'Google'
      default:
        return protocol
    }
  }

  const authStatusText = (provider: CustomProviderView): { label: string; warn?: boolean } => {
    if (provider.authMode === 'none') {
      return { label: t('providers.custom.noKeyRequired') }
    }
    if (provider.authMode === 'env') {
      const name = provider.envVar ?? ''
      return provider.envDetected
        ? { label: t('providers.custom.envDetected', { name }) }
        : { label: t('providers.custom.envMissing', { name }), warn: true }
    }
    return provider.hasSavedKey
      ? { label: t('providers.custom.keySaved') }
      : { label: t('providers.custom.keyMissing'), warn: true }
  }

  const handleSaveProvider = async (input: CustomProviderInput) => {
    setBusy(true)
    setActionError(null)
    try {
      const next = await api.saveCustomProvider(input)
      setState(next)
      setProviderDialog({ open: false })
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmDeleteProvider = async () => {
    if (!deletingProvider || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const next = await api.removeCustomProvider(deletingProvider.id)
      setState(next)
      setDeletingProvider(null)
    } catch (err) {
      setActionError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveModel = async (input: CustomModelInput) => {
    if (!modelDialog) return
    setBusy(true)
    setActionError(null)
    try {
      const next = await api.saveCustomModel(modelDialog.provider.id, input)
      setState(next)
      setModelDialog(null)
    } finally {
      setBusy(false)
    }
  }

  const handleImportModels = async (providerId: string, models: CustomModelInput[]) => {
    setBusy(true)
    setActionError(null)
    try {
      const next = await api.saveCustomModel(providerId, models)
      setState(next)
      setDiscoverProvider(null)
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteModel = async (providerId: string, modelId: string) => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      const next = await api.removeCustomModel(providerId, modelId)
      setState(next)
    } catch (err) {
      setActionError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const fileOrRuntimeError = state.error ?? state.runtimeError

  return (
    <section className="flex flex-col gap-4 pt-2" aria-labelledby="custom-providers-heading">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="custom-providers-heading" className="text-sm font-medium">
            {t('providers.custom.sectionTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('providers.custom.sectionDescription')}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || configBlocked}
          onClick={() => setProviderDialog({ open: true })}
        >
          <Plus data-icon="inline-start" />
          {t('providers.custom.addProvider')}
        </Button>
      </div>

      {fileOrRuntimeError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-start justify-between gap-3">
            <span className="whitespace-pre-wrap break-words text-xs">{fileOrRuntimeError}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              disabled={busy}
              onClick={() => void load()}
            >
              <RotateCw data-icon="inline-start" />
              {t('providers.custom.reloadConfig')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {state.providers.length > 0 ? (
        <div className="flex flex-col gap-3">
          {state.providers.map((provider) => {
            const auth = authStatusText(provider)
            return (
              <Card key={provider.id} className="gap-3 py-3">
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="truncate text-sm">{provider.name}</CardTitle>
                      {provider.name !== provider.id ? (
                        <span className="font-mono text-xs text-muted-foreground">{provider.id}</span>
                      ) : null}
                      <Badge variant="secondary">{protocolBadgeLabel(provider.api)}</Badge>
                      <span
                        className={cn(
                          'text-xs',
                          auth.warn ? 'text-warning' : 'text-muted-foreground'
                        )}
                      >
                        {auth.label}
                      </span>
                    </div>
                    <CardDescription className="truncate font-mono text-xs">
                      {provider.baseUrl}
                    </CardDescription>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={locked || configBlocked}
                      onClick={() => setDiscoverProvider(provider)}
                    >
                      <Radar data-icon="inline-start" />
                      {t('providers.custom.fetchModels')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={locked || configBlocked}
                      onClick={() => setModelDialog({ provider })}
                    >
                      <Plus data-icon="inline-start" />
                      {t('providers.custom.addModel')}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t('providers.custom.editProvider')} ${provider.name}`}
                          disabled={locked || configBlocked}
                          onClick={() => setProviderDialog({ open: true, provider })}
                        >
                          <Settings className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('providers.custom.editProvider')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t('providers.custom.deleteProvider')} ${provider.name}`}
                          disabled={locked || configBlocked}
                          onClick={() => setDeletingProvider(provider)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('providers.custom.deleteProvider')}</TooltipContent>
                    </Tooltip>
                  </div>
                </CardHeader>

                <CardContent className="flex flex-col gap-2">
                  {provider.models.length > 0 ? (
                    <div className="divide-y divide-border/50 rounded-lg border border-foreground/10">
                      {provider.models.map((model) => (
                        <div
                          key={model.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{model.name}</span>
                              {model.name !== model.id ? (
                                <span className="truncate font-mono text-xs text-muted-foreground">
                                  {model.id}
                                </span>
                              ) : null}
                              {model.reasoning ? (
                                <Badge variant="secondary">{t('providers.custom.badgeReasoning')}</Badge>
                              ) : null}
                              {model.vision ? (
                                <Badge variant="secondary">{t('providers.custom.badgeVision')}</Badge>
                              ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t('providers.custom.modelMeta', {
                                context: formatModelTokens(model.contextWindow),
                                maxOutput: formatModelTokens(model.maxTokens)
                              })}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`${t('providers.custom.editModel')} ${model.name}`}
                                  disabled={locked || configBlocked}
                                  onClick={() => setModelDialog({ provider, model })}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('providers.custom.editModel')}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`${t('providers.custom.deleteModel')} ${model.name}`}
                                  disabled={locked || configBlocked}
                                  onClick={() => void handleDeleteModel(provider.id, model.id)}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('providers.custom.deleteModel')}</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-foreground/10 px-3 py-3 text-xs text-muted-foreground">
                      {t('providers.custom.noModels')}
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : !state.error ? (
        <Empty className="min-h-40 border">
          <EmptyHeader>
            <EmptyTitle>{t('providers.custom.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('providers.custom.emptyDescription')}</EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            disabled={locked || configBlocked}
            onClick={() => setProviderDialog({ open: true })}
          >
            {t('providers.custom.addProvider')}
          </Button>
        </Empty>
      ) : null}

      <CustomProviderDialog
        open={providerDialog.open}
        provider={providerDialog.provider}
        busy={busy}
        onSave={handleSaveProvider}
        onClose={() => setProviderDialog({ open: false })}
      />

      <CustomModelDialog
        open={modelDialog !== null}
        providerName={modelDialog?.provider.name ?? ''}
        model={modelDialog?.model}
        busy={busy}
        onSave={handleSaveModel}
        onClose={() => setModelDialog(null)}
      />

      <DiscoverModelsDialog
        provider={discoverProvider}
        busy={busy}
        onImport={handleImportModels}
        onClose={() => setDiscoverProvider(null)}
      />

      <AlertDialog
        open={deletingProvider !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setDeletingProvider(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('providers.custom.deleteProviderTitle', { name: deletingProvider?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('providers.custom.deleteProviderDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmDeleteProvider()
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
