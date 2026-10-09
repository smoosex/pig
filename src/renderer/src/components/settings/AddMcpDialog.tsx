import { useEffect, useId, useState } from 'react'
import { api, type McpImportEntry, type McpMarketServer, type McpServerView } from '../../ipc/api'
import { fillMarketConfig, literalMcpValue } from '../../../../shared/mcp-market'
import { useT } from '../../hooks/useT'
import { useToolSettingsStore } from '../../stores/tool-settings'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Switch } from '../ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { HighlightedCode } from '../HighlightedCode'

function ConfigField({
  label,
  value,
  change,
  multiline,
  disabled
}: {
  label: string
  value: string
  change(value: string): void
  multiline?: boolean
  disabled: boolean
}) {
  const id = useId()
  return (
    <Field data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea
          id={id}
          disabled={disabled}
          value={value}
          rows={3}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          disabled={disabled}
          value={value}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </Field>
  )
}

export function AddMcpDialog({
  recipe,
  server,
  importJson,
  onClose
}: {
  recipe?: McpMarketServer
  server?: McpServerView
  importJson?: boolean
  onClose(): void
}) {
  const t = useT()
  const busy = useToolSettingsStore((s) => s.busy)
  const run = useToolSettingsStore((s) => s.run)
  const error = useToolSettingsStore((s) => s.error)
  const initial = server?.config ?? recipe?.config
  const [base, setBase] = useState<Record<string, unknown>>({ ...initial })
  const [mode, setMode] = useState(server || importJson ? 'json' : 'form')
  const [name, setName] = useState(server?.name ?? recipe?.name ?? '')
  const [transport, setTransport] = useState(initial && 'command' in initial ? 'stdio' : 'http')
  const [url, setUrl] = useState(initial && 'url' in initial ? initial.url : '')
  const [command, setCommand] = useState(initial && 'command' in initial ? initial.command : '')
  const [args, setArgs] = useState(
    JSON.stringify(initial && 'command' in initial ? (initial.args ?? []) : [])
  )
  const [env, setEnv] = useState(
    JSON.stringify(initial && 'command' in initial ? (initial.env ?? {}) : {}, null, 2)
  )
  const [apiKey, setApiKey] = useState('')
  const [headers, setHeaders] = useState(
    JSON.stringify(initial && 'url' in initial ? (initial.headers ?? {}) : {}, null, 2)
  )
  const [json, setJson] = useState(
    JSON.stringify(initial ?? (importJson ? { mcpServers: {} } : { url: '' }), null, 2)
  )
  const [values, setValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<{ json: string; entries: McpImportEntry[] }>()
  const [replace, setReplace] = useState(false)
  const [localError, setLocalError] = useState<string>()
  useEffect(() => {
    setPreview(undefined)
    setReplace(false)
  }, [mode, name, transport, url, command, args, env, headers, apiKey, json, values])
  const payload = (): string => {
    if (mode === 'json') return json
    if (recipe) return JSON.stringify(fillMarketConfig(recipe, values), null, 2)
    const config = { ...base }
    if (transport === 'http') {
      for (const key of ['command', 'args', 'env', 'cwd']) delete config[key]
      const nextHeaders = JSON.parse(headers) as Record<string, string>
      if (apiKey.trim()) {
        delete config.auth
        for (const key of Object.keys(nextHeaders))
          if (key.toLowerCase() === 'authorization') delete nextHeaders[key]
        nextHeaders.Authorization = literalMcpValue(`Bearer ${apiKey.trim()}`)
      }
      Object.assign(config, { type: 'http', url, headers: nextHeaders })
    } else {
      for (const key of ['url', 'headers', 'oauth', 'auth']) delete config[key]
      Object.assign(config, {
        type: 'stdio',
        command,
        args: JSON.parse(args),
        env: JSON.parse(env)
      })
    }
    return JSON.stringify(config, null, 2)
  }
  const changeMode = (next: string) => {
    if (!next) return
    try {
      if (next === 'json') setJson(payload())
      else if (recipe) {
        if (JSON.stringify(JSON.parse(json)) !== JSON.stringify(fillMarketConfig(recipe, values)))
          throw new Error(t('mcp.keepJson'))
      } else {
        const config = JSON.parse(json) as Record<string, unknown>
        if (!config || typeof config !== 'object' || Array.isArray(config))
          throw new Error(t('mcp.configHint'))
        if (config.mcpServers) throw new Error(t('mcp.formSingle'))
        setBase(config)
        setTransport(typeof config.command === 'string' ? 'stdio' : 'http')
        setUrl(typeof config.url === 'string' ? config.url : '')
        setCommand(typeof config.command === 'string' ? config.command : '')
        setArgs(JSON.stringify(config.args ?? []))
        setEnv(JSON.stringify(config.env ?? {}, null, 2))
        setHeaders(JSON.stringify(config.headers ?? {}, null, 2))
        setApiKey('')
      }
      setMode(next)
      setLocalError(undefined)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    }
  }
  const conflicts =
    preview?.entries.filter((entry) => entry.conflict && entry.name !== server?.name) ?? []
  const field = (
    label: string,
    value: string,
    change: (value: string) => void,
    multiline = false
  ) => (
    <ConfigField
      label={label}
      value={value}
      change={change}
      multiline={multiline}
      disabled={busy}
    />
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(server ? 'mcp.edit' : importJson ? 'mcp.import' : 'mcp.add')}
          </DialogTitle>
          <DialogDescription>{t('mcp.safety')}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-auto px-1">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="mcp-name">{t('mcp.name')}</FieldLabel>
              <Input
                id="mcp-name"
                disabled={busy}
                readOnly={!!server}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldDescription>{t('mcp.nameDescription')}</FieldDescription>
            </Field>
            <ToggleGroup
              type="single"
              variant="outline"
              value={mode}
              disabled={busy}
              onValueChange={changeMode}
            >
              <ToggleGroupItem value="form">{t('mcp.form')}</ToggleGroupItem>
              <ToggleGroupItem value="json">JSON</ToggleGroupItem>
            </ToggleGroup>
            {mode === 'json' ? (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="mcp-json">{t('mcp.config')}</FieldLabel>
                <Textarea
                  id="mcp-json"
                  disabled={busy}
                  rows={10}
                  value={json}
                  onChange={(event) => setJson(event.target.value)}
                />
                <FieldDescription>{t('mcp.configHint')}</FieldDescription>
              </Field>
            ) : recipe ? (
              <>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {'url' in recipe.config
                    ? recipe.config.url
                    : [recipe.config.command, ...(recipe.config.args ?? [])].join(' ')}
                </p>
                {recipe.inputs.map((input) => (
                  <Field key={`${input.where}:${input.key}`} data-disabled={busy}>
                    <FieldLabel htmlFor={`mcp-input-${input.key}`}>
                      {input.label}
                      {input.required ? ' *' : ''}
                    </FieldLabel>
                    <Input
                      id={`mcp-input-${input.key}`}
                      type={input.secret ? 'password' : 'text'}
                      disabled={busy}
                      value={values[input.key] ?? ''}
                      onChange={(event) =>
                        setValues((old) => ({ ...old, [input.key]: event.target.value }))
                      }
                    />
                    {input.description ? (
                      <FieldDescription>{input.description}</FieldDescription>
                    ) : null}
                  </Field>
                ))}
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel>{t('mcp.transport')}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={transport}
                    disabled={busy}
                    onValueChange={(value) => {
                      if (value) setTransport(value)
                    }}
                  >
                    <ToggleGroupItem value="http">{t('mcp.http')}</ToggleGroupItem>
                    <ToggleGroupItem value="stdio">{t('mcp.stdio')}</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                {transport === 'http' ? (
                  <>
                    {field(t('mcp.url'), url, setUrl)}
                    <Field data-disabled={busy}>
                      <FieldLabel htmlFor="mcp-api-key">{t('mcp.apiKey')}</FieldLabel>
                      <Input
                        id="mcp-api-key"
                        type="password"
                        autoComplete="off"
                        disabled={busy}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </Field>
                    {field(t('mcp.headers'), headers, setHeaders, true)}
                  </>
                ) : (
                  <>
                    {field(t('mcp.command'), command, setCommand)}
                    {field(t('mcp.args'), args, setArgs, true)}
                    {field(t('mcp.env'), env, setEnv, true)}
                  </>
                )}
              </>
            )}
          </FieldGroup>
          {localError || error ? (
            <Alert variant="destructive">
              <AlertDescription>{localError || error}</AlertDescription>
            </Alert>
          ) : null}
          {preview ? (
            <div className="flex flex-col gap-2">
              {preview.entries.map((entry) => (
                <Collapsible key={entry.name}>
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      {entry.name} · {'url' in entry.config ? 'HTTP' : 'stdio'}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <HighlightedCode lang="json" code={JSON.stringify(entry.config, null, 2)} />
                  </CollapsibleContent>
                </Collapsible>
              ))}
              {conflicts.length ? (
                <Alert>
                  <AlertDescription>
                    {t('mcp.conflicts', { names: conflicts.map((entry) => entry.name).join(', ') })}
                  </AlertDescription>
                </Alert>
              ) : null}
              {conflicts.length ? (
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="mcp-replace">{t('mcp.confirmReplace')}</FieldLabel>
                  <Switch
                    id="mcp-replace"
                    checked={replace}
                    onCheckedChange={setReplace}
                    disabled={busy}
                  />
                </Field>
              ) : null}
              <p className="text-xs text-muted-foreground">{t('mcp.configured')}</p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const source = payload()
                const entries = await api.previewMcpImport(source, name.trim())
                setPreview({ json: source, entries })
                return entries
              })
            }
          >
            {t('mcp.preview')}
          </Button>
          <Button
            disabled={busy || !preview?.entries.length || (!!conflicts.length && !replace)}
            onClick={() => {
              if (preview)
                void run(() =>
                  api.importMcpServers(
                    preview.json,
                    preview.entries.filter((entry) => entry.conflict).map((entry) => entry.name),
                    name.trim()
                  )
                ).then((result) => {
                  if (result) onClose()
                })
            }}
          >
            {t('mcp.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
