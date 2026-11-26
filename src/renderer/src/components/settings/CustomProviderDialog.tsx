import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, Plus, Radar, Trash2 } from 'lucide-react'
import { CUSTOM_MODEL_APIS } from '../../../../shared/custom-models'
import {
  api,
  type CustomHeaderInput,
  type CustomProviderAuthMode,
  type CustomProviderInput,
  type CustomProviderView,
  type DiscoveredRemoteModel
} from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { Switch } from '../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { formatModelTokens, toCustomModelInput } from './DiscoverModelsDialog'

interface HeaderDraft {
  name: string
  value: string
  keepSaved: boolean
  hadSaved: boolean
}

export function CustomProviderDialog({
  open,
  provider,
  busy,
  onSave,
  onClose
}: {
  open: boolean
  provider?: CustomProviderView
  busy: boolean
  onSave: (input: CustomProviderInput) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<string>('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [authMode, setAuthMode] = useState<CustomProviderAuthMode>('api_key')
  const [apiKey, setApiKey] = useState('')
  const [envVar, setEnvVar] = useState('')
  const [authHeader, setAuthHeader] = useState(false)
  const [headers, setHeaders] = useState<HeaderDraft[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [candidates, setCandidates] = useState<DiscoveredRemoteModel[]>([])
  const [selectedModels, setSelectedModels] = useState<Set<string>>(() => new Set())
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(provider?.id ?? '')
    setName(provider && provider.name !== provider.id ? provider.name : '')
    setProtocol(provider?.api ?? 'openai-completions')
    setBaseUrl(provider?.baseUrl ?? '')
    setAuthMode(provider?.authMode ?? 'api_key')
    setApiKey('')
    setEnvVar(provider?.envVar ?? '')
    setAuthHeader(provider?.authHeader ?? false)
    const initialHeaders: HeaderDraft[] = (provider?.headers ?? []).map((item) => ({
      name: item.name,
      value: item.envVar ? `$${item.envVar}` : '',
      keepSaved: !item.envVar && item.hasSavedValue,
      hadSaved: !item.envVar && item.hasSavedValue
    }))
    setHeaders(initialHeaders)
    setAdvancedOpen(Boolean(provider?.authHeader || initialHeaders.length > 0))
    setCandidates([])
    setSelectedModels(new Set())
    setFetching(false)
    setError(null)
  }, [open, provider])

  const protocolOptions = useMemo(() => {
    const known: string[] = [...CUSTOM_MODEL_APIS]
    if (protocol && !known.includes(protocol)) known.push(protocol)
    return known
  }, [protocol])

  const protocolLabel = (value: string): string => {
    switch (value) {
      case 'openai-completions':
        return t('providers.custom.protocolOpenaiCompletions')
      case 'openai-responses':
        return t('providers.custom.protocolOpenaiResponses')
      case 'anthropic-messages':
        return t('providers.custom.protocolAnthropicMessages')
      case 'google-generative-ai':
        return t('providers.custom.protocolGoogleGenerativeAi')
      default:
        return value
    }
  }

  const buildHeaderInputs = (): CustomHeaderInput[] =>
    headers
      .filter((row) => row.name.trim() || row.value.trim() || row.keepSaved)
      .map((row) =>
        row.keepSaved
          ? { name: row.name.trim(), keepSaved: true }
          : { name: row.name.trim(), value: row.value.trim() }
      )

  const probeModels = async () => {
    if (fetching || busy || !baseUrl.trim()) return
    setFetching(true)
    setError(null)
    try {
      const list = await api.discoverCustomModels({
        providerId: provider?.id,
        api: protocol,
        baseUrl: baseUrl.trim(),
        authMode,
        apiKey: apiKey.trim() || undefined,
        envVar: envVar.trim() || undefined,
        authHeader,
        headers: buildHeaderInputs()
      })
      setCandidates(list)
      setSelectedModels(new Set())
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setFetching(false)
    }
  }

  const toggleModel = (modelId: string, checked: boolean) => {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      if (checked) next.add(modelId)
      else next.delete(modelId)
      return next
    })
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError(null)
    try {
      const initialModels = !provider && selectedModels.size > 0
        ? candidates.filter((item) => selectedModels.has(item.id)).map(toCustomModelInput)
        : undefined
      await onSave({
        ...(provider ? { previousId: provider.id } : {}),
        id: id.trim(),
        name: name.trim() || undefined,
        api: protocol,
        baseUrl: baseUrl.trim(),
        authMode,
        ...(authMode === 'api_key' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(authMode === 'env' ? { envVar: envVar.trim() } : {}),
        authHeader,
        headers: buildHeaderInputs(),
        ...(initialModels ? { models: initialModels } : {})
      })
    } catch (err) {
      setError(failureMessage(err))
    }
  }

  const canSubmit =
    Boolean(id.trim() && baseUrl.trim()) &&
    (authMode === 'none' ||
      (authMode === 'env' && Boolean(envVar.trim())) ||
      (authMode === 'api_key' && Boolean(apiKey.trim() || provider?.hasSavedKey)))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {provider ? t('providers.custom.editProvider') : t('providers.custom.addProvider')}
          </DialogTitle>
          <DialogDescription>{t('providers.custom.sectionDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <FieldGroup className="gap-3.5">
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="custom-provider-id">{t('providers.custom.providerId')}</FieldLabel>
                  <Input
                    id="custom-provider-id"
                    autoFocus={!provider}
                    value={id}
                    disabled={busy}
                    placeholder={t('providers.custom.providerIdPlaceholder')}
                    onChange={(e) => setId(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="custom-provider-name">{t('providers.custom.displayName')}</FieldLabel>
                  <Input
                    id="custom-provider-name"
                    autoFocus={Boolean(provider)}
                    value={name}
                    disabled={busy}
                    placeholder={t('providers.custom.displayNamePlaceholder')}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">{t('providers.custom.providerIdHint')}</p>

              <Field>
                <FieldLabel htmlFor="custom-provider-protocol">{t('providers.custom.protocol')}</FieldLabel>
                <Select value={protocol} disabled={busy} onValueChange={setProtocol}>
                  <SelectTrigger id="custom-provider-protocol" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {protocolOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {protocolLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="custom-provider-url">{t('providers.custom.baseUrl')}</FieldLabel>
                <Input
                  id="custom-provider-url"
                  value={baseUrl}
                  disabled={busy}
                  placeholder={t('providers.custom.baseUrlPlaceholder')}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel>{t('providers.custom.authMode')}</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0.5}
                  size="sm"
                  className="self-start"
                  value={authMode}
                  disabled={busy}
                  onValueChange={(next) => {
                    if (next === 'api_key' || next === 'env' || next === 'none') setAuthMode(next)
                  }}
                >
                  <ToggleGroupItem value="api_key">{t('providers.custom.authApiKey')}</ToggleGroupItem>
                  <ToggleGroupItem value="env">{t('providers.custom.authEnv')}</ToggleGroupItem>
                  <ToggleGroupItem value="none">{t('providers.custom.authNone')}</ToggleGroupItem>
                </ToggleGroup>
              </Field>

              {authMode === 'api_key' ? (
                <Field>
                  <FieldLabel htmlFor="custom-provider-key">{t('providers.custom.apiKeyLabel')}</FieldLabel>
                  <Input
                    id="custom-provider-key"
                    type="password"
                    value={apiKey}
                    disabled={busy}
                    placeholder={
                      provider?.hasSavedKey
                        ? t('providers.custom.apiKeySavedPlaceholder')
                        : t('providers.custom.apiKeyPlaceholder')
                    }
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </Field>
              ) : authMode === 'env' ? (
                <Field>
                  <FieldLabel htmlFor="custom-provider-env">{t('providers.custom.envVarLabel')}</FieldLabel>
                  <Input
                    id="custom-provider-env"
                    value={envVar}
                    disabled={busy}
                    placeholder={t('providers.custom.envVarPlaceholder')}
                    onChange={(e) => setEnvVar(e.target.value)}
                  />
                </Field>
              ) : (
                <p className="text-xs text-muted-foreground">{t('providers.custom.authNoneHint')}</p>
              )}

              {!provider ? (
                <div className="flex flex-col gap-2.5 rounded-lg border border-foreground/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{t('providers.custom.modelsHeading')}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy || fetching || !baseUrl.trim()}
                      onClick={() => void probeModels()}
                    >
                      {fetching ? (
                        <LoaderCircle className="size-3.5 animate-spin" data-icon="inline-start" />
                      ) : (
                        <Radar className="size-3.5" data-icon="inline-start" />
                      )}
                      {fetching ? t('providers.custom.fetchingModels') : t('providers.custom.fetchModels')}
                    </Button>
                  </div>
                  {candidates.length > 0 ? (
                    <div className="max-h-44 overflow-auto rounded-md border border-foreground/10 divide-y divide-border/50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {candidates.map((item) => (
                        <label
                          key={item.id}
                          className="flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-xs hover:bg-accent/50"
                        >
                          <Checkbox
                            checked={selectedModels.has(item.id)}
                            disabled={busy}
                            onCheckedChange={(val) => toggleModel(item.id, val === true)}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono">{item.id}</span>
                          {item.reasoning ? (
                            <Badge variant="secondary">{t('providers.custom.badgeReasoning')}</Badge>
                          ) : null}
                          {item.vision ? (
                            <Badge variant="secondary">{t('providers.custom.badgeVision')}</Badge>
                          ) : null}
                          {item.contextWindow ? (
                            <span className="text-muted-foreground">{formatModelTokens(item.contextWindow)}</span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('providers.custom.initialModelsHint')}</p>
                  )}
                </div>
              ) : null}

              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="flex flex-col gap-3">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start px-1.5 text-xs text-muted-foreground"
                  >
                    {advancedOpen ? (
                      <ChevronDown data-icon="inline-start" />
                    ) : (
                      <ChevronRight data-icon="inline-start" />
                    )}
                    {t('providers.custom.advanced')}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-3.5 rounded-lg border border-foreground/10 p-3">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="custom-provider-auth-header">
                        {t('providers.custom.authHeader')}
                      </FieldLabel>
                      <FieldDescription>{t('providers.custom.authHeaderHint')}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id="custom-provider-auth-header"
                      checked={authHeader}
                      disabled={busy}
                      onCheckedChange={setAuthHeader}
                    />
                  </Field>

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">{t('providers.custom.headers')}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          setHeaders((prev) => [
                            ...prev,
                            { name: '', value: '', keepSaved: false, hadSaved: false }
                          ])
                        }
                      >
                        <Plus data-icon="inline-start" />
                        {t('providers.custom.addHeader')}
                      </Button>
                    </div>
                    {headers.map((row, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          className="flex-1"
                          value={row.name}
                          disabled={busy || row.keepSaved}
                          placeholder={t('providers.custom.headerNamePlaceholder')}
                          onChange={(e) =>
                            setHeaders((prev) =>
                              prev.map((item, i) =>
                                i === index ? { ...item, name: e.target.value } : item
                              )
                            )
                          }
                        />
                        {row.keepSaved ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex-1 justify-start text-xs text-muted-foreground"
                            disabled={busy}
                            onClick={() =>
                              setHeaders((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, keepSaved: false, value: '' } : item
                                )
                              )
                            }
                          >
                            {t('providers.custom.headerSavedPlaceholder')}
                          </Button>
                        ) : (
                          <Input
                            className="flex-1"
                            value={row.value}
                            disabled={busy}
                            placeholder={t('providers.custom.headerValuePlaceholder')}
                            onChange={(e) =>
                              setHeaders((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, value: e.target.value } : item
                                )
                              )
                            }
                          />
                        )}
                        {!row.keepSaved && row.hadSaved ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              setHeaders((prev) =>
                                prev.map((item, i) =>
                                  i === index ? { ...item, keepSaved: true, value: '' } : item
                                )
                              )
                            }
                          >
                            {t('providers.custom.keepSavedHeader')}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common.delete')}
                          disabled={busy}
                          onClick={() => setHeaders((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </FieldGroup>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !canSubmit}>
              {busy ? t('providers.custom.saving') : t('providers.custom.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
