/**
 * Adding, editing and importing MCP servers.
 *
 * A catalog recipe gets its own sheet: the listing fixes the transport and the name, so the form
 * only collects the inputs that listing declares, and saving validates before it writes. Manual
 * entry, editing and JSON import keep the generic form plus a JSON escape hatch, because a
 * configuration can carry fields no form models.
 */
import { useEffect, useId, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { api, type McpImportEntry, type McpMarketServer, type McpServerView } from '../../ipc/api'
import { fillMarketConfig, literalMcpValue, marketInvocation } from '../../../../shared/mcp-market'
import { useT } from '../../hooks/useT'
import { listingText } from '../../lib/i18n'
import { useToolSettingsStore } from '../../stores/tool-settings'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Switch } from '../ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { HighlightedCode } from '../HighlightedCode'
import { McpIcon } from './McpIcon'

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
  const [preview, setPreview] = useState<McpImportEntry[]>()
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
      else {
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
  const missing = recipe?.inputs.find((input) => input.required && !values[input.key]?.trim())
  const conflicts = preview?.filter((entry) => entry.conflict && entry.name !== server?.name) ?? []
  const save = () => {
    setLocalError(undefined)
    void run(async () => {
      const source = payload()
      const entries = await api.previewMcpImport(source, name.trim())
      // A payload that resolves to no server would otherwise close the dialog as if it had saved.
      if (!entries.length) throw new Error(t('mcp.emptyImport'))
      const replacing = entries.filter((entry) => entry.conflict && entry.name !== server?.name)
      // A same-name entry is only overwritten once the user has seen which ones those are.
      if (replacing.length && !replace) {
        setPreview(entries)
        return undefined
      }
      return api.importMcpServers(
        source,
        entries.filter((entry) => entry.conflict).map((entry) => entry.name),
        name.trim(),
        recipe?.icon
      )
    }).then((result) => {
      if (result) onClose()
    })
  }
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
  const conflictBlock = preview ? (
    <div className="flex flex-col gap-2">
      {preview.map((entry) => (
        <Collapsible key={entry.name}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className="w-full justify-start">
              {entry.name} · {'url' in entry.config ? t('mcp.remote') : entry.config.command}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <HighlightedCode lang="json" code={JSON.stringify(entry.config, null, 2)} />
          </CollapsibleContent>
        </Collapsible>
      ))}
      {conflicts.length ? (
        <>
          <Alert>
            <AlertDescription>
              {t('mcp.conflicts', { names: conflicts.map((entry) => entry.name).join(', ') })}
            </AlertDescription>
          </Alert>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="mcp-replace">{t('mcp.confirmReplace')}</FieldLabel>
            <Switch
              id="mcp-replace"
              checked={replace}
              onCheckedChange={setReplace}
              disabled={busy}
            />
          </Field>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('mcp.configured')}</p>
    </div>
  ) : null
  const feedback = localError || error
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!recipe}>
        {recipe ? (
          <DialogHeader className="-mx-4 -mt-4 flex-row items-center gap-3 border-b p-4">
            <McpIcon source={recipe.icon} name={recipe.title || recipe.name} className="size-11" />
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="truncate">{recipe.title}</DialogTitle>
              <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                {recipe.publisher ? <span className="truncate">{recipe.publisher}</span> : null}
                <Badge variant="secondary">
                  {'url' in recipe.config ? t('mcp.remote') : recipe.config.command}
                </Badge>
              </div>
            </div>
            {recipe.homepage ? (
              <a
                href={recipe.homepage}
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex shrink-0 items-center gap-1 text-sm text-link hover:underline"
              >
                {t('mcp.homepage')}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
          </DialogHeader>
        ) : (
          <DialogHeader>
            <DialogTitle>
              {t(server ? 'mcp.edit' : importJson ? 'mcp.import' : 'mcp.add')}
            </DialogTitle>
          </DialogHeader>
        )}
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-auto px-1">
          {recipe ? (
            <>
              {recipe.description ? (
                <p className="text-sm text-muted-foreground">
                  {listingText(t, recipe.descriptionKey, recipe.description)}
                </p>
              ) : null}
              {/* What the recipe writes, for inspection before it is added: the placeholders stay
                  visible because the values are only known once the inputs below are filled. */}
              <p className="break-all font-mono text-xs text-muted-foreground">
                {marketInvocation(recipe)}
              </p>
              {/* The label column is sized by its widest label, so a translation never wraps
                  mid-word while every row's input still starts at the same edge. */}
              <FieldGroup className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-3">
                {recipe.inputs.map((input) => (
                  <Field
                    key={`${input.where}:${input.key}`}
                    data-disabled={busy}
                    orientation="horizontal"
                    className="col-span-2 grid grid-cols-subgrid items-start gap-x-3 *:data-[slot=field-label]:justify-self-end *:data-[slot=field-label]:pt-1.5 *:data-[slot=field-label]:whitespace-nowrap *:data-[slot=field-label]:text-right"
                  >
                    <FieldLabel htmlFor={`mcp-input-${input.key}`}>
                      {listingText(t, input.labelKey, input.label)}
                      {input.required ? ' *' : ` ${t('mcp.optional')}`}
                    </FieldLabel>
                    <FieldContent>
                      <Input
                        id={`mcp-input-${input.key}`}
                        type={input.secret ? 'password' : 'text'}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono text-xs"
                        placeholder={input.placeholder ?? input.key}
                        disabled={busy}
                        value={values[input.key] ?? ''}
                        onChange={(event) =>
                          setValues((old) => ({ ...old, [input.key]: event.target.value }))
                        }
                      />
                      <FieldDescription className="text-xs">
                        {[
                          input.descriptionKey
                            ? listingText(t, input.descriptionKey, input.description ?? '')
                            : input.description,
                          // An unknown place shows no hint rather than a wrong one.
                          input.where === 'env'
                            ? t('mcp.asEnv', { key: input.key })
                            : input.where === 'header'
                              ? t('mcp.asHeader', { key: input.key })
                              : input.where === 'arg'
                                ? t('mcp.asArg', { key: input.key })
                                : ''
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </FieldGroup>
            </>
          ) : (
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
          )}
          {feedback ? (
            <Alert variant="destructive">
              <AlertDescription>{feedback}</AlertDescription>
            </Alert>
          ) : null}
          {conflictBlock}
        </div>
        <DialogFooter className="items-center">
          <span className="mr-auto truncate font-mono text-xs text-muted-foreground">
            {name.trim()}
          </span>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={
              busy ||
              !!missing ||
              (!!conflicts.length && !replace) ||
              // A form entry with no address could never connect; JSON may still hold a full object.
              (!recipe && mode === 'form' && !(transport === 'http' ? url.trim() : command.trim()))
            }
            onClick={save}
          >
            {t(recipe ? 'mcp.addServer' : 'mcp.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
