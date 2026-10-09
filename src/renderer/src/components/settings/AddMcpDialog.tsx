/**
 * Adding, editing and importing MCP servers.
 *
 * A catalog recipe gets its own sheet: the listing fixes the transport and the name, so the form
 * only collects the inputs that listing declares, and saving validates before it writes. Manual
 * entry uses an argv command line and key/value rows. Pasting a single JSON configuration fills
 * the form; several entries remain in the JSON editor. JSON also preserves unmodeled fields.
 */
import { useEffect, useState, type ClipboardEvent } from 'react'
import { ExternalLink, Globe, SquareTerminal } from 'lucide-react'
import { api, type McpImportEntry, type McpMarketServer, type McpServerView } from '../../ipc/api'
import { fillMarketConfig, marketInvocation } from '../../../../shared/mcp-market'
import { useT } from '../../hooks/useT'
import { listingText } from '../../lib/i18n'
import { mcpFormFromConfig, mcpConfigFromForm, parseMcpPaste } from '../../lib/mcp-form'
import { useToolSettingsStore } from '../../stores/tool-settings'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { Switch } from '../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { HighlightedCode } from '../HighlightedCode'
import { McpIcon } from './McpIcon'
import { ManualMcpFields } from './ManualMcpFields'

export function AddMcpDialog({
  recipe,
  server,
  onClose
}: {
  recipe?: McpMarketServer
  server?: McpServerView
  onClose(): void
}) {
  const t = useT()
  const busy = useToolSettingsStore((s) => s.busy)
  const run = useToolSettingsStore((s) => s.run)
  const error = useToolSettingsStore((s) => s.error)
  const initial = server?.config ?? recipe?.config
  const [base, setBase] = useState<Record<string, unknown>>({ ...initial })
  const [mode, setMode] = useState(server ? 'json' : 'form')
  const [name, setName] = useState(server?.name ?? recipe?.name ?? '')
  const [form, setForm] = useState(() => mcpFormFromConfig({ ...(initial ?? { command: '' }) }, t))
  const [json, setJson] = useState(initial ? JSON.stringify(initial, null, 2) : '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<McpImportEntry[]>()
  const [replace, setReplace] = useState(false)
  const [localError, setLocalError] = useState<string>()
  useEffect(() => {
    setPreview(undefined)
    setReplace(false)
  }, [mode, name, form, json, values])
  const payload = (): string => {
    if (mode === 'json') return json
    if (recipe) return JSON.stringify(fillMarketConfig(recipe, values), null, 2)
    return JSON.stringify(mcpConfigFromForm(base, form, t), null, 2)
  }
  const fillForm = (config: Record<string, unknown>, nextName?: string) => {
    const nextForm = mcpFormFromConfig(config, t)
    setBase(config)
    setForm(nextForm)
    if (nextName !== undefined && !server) setName(nextName)
  }
  const changeMode = (next: 'form' | 'json') => {
    try {
      if (next === 'json') {
        const rows = form.transport === 'http' ? form.headers : form.env
        const hasConfig =
          Object.keys(base).length > 0 ||
          !!(form.transport === 'http' ? form.url.trim() : form.commandLine.trim()) ||
          rows.some((row) => row.key || row.value)
        setJson(hasConfig ? payload() : '')
      } else if (json.trim()) {
        const pasted = parseMcpPaste(json, t)
        if (pasted.kind === 'multiple') throw new Error(t('mcp.formSingle'))
        fillForm(pasted.config, pasted.name)
      }
      setMode(next)
      setLocalError(undefined)
    } catch (error) {
      // Invalid JSON/argv must stay editable; no form state is changed until conversion succeeds.
      setLocalError(error instanceof Error ? error.message : String(error))
    }
  }
  const pasteConfig = (event: ClipboardEvent<HTMLDivElement>) => {
    if (recipe || busy || (event.target instanceof HTMLElement && event.target.id === 'mcp-json'))
      return
    const text = event.clipboardData.getData('text/plain').trim()
    if (!text.startsWith('{') && !text.startsWith('[')) return
    event.preventDefault()
    try {
      const pasted = parseMcpPaste(text, t)
      if (pasted.kind === 'single') {
        fillForm(pasted.config, pasted.name)
        setMode('form')
      } else {
        setJson(JSON.stringify(pasted.document, null, 2))
        setMode('json')
      }
      setLocalError(undefined)
    } catch (error) {
      // A configuration-looking paste is intercepted, so malformed JSON needs a visible error
      // instead of silently disappearing or overwriting whichever field happened to have focus.
      setLocalError(
        t('mcp.pasteFailed', { error: error instanceof Error ? error.message : String(error) })
      )
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
      <DialogContent className="sm:max-w-2xl" showCloseButton={false} onPaste={pasteConfig}>
        {recipe ? (
          <DialogHeader className="-mx-4 -mt-4 flex-row items-center gap-3 border-b p-4">
            <McpIcon source={recipe.icon} name={recipe.title || recipe.name} className="size-10" />
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="truncate text-sm">{recipe.title}</DialogTitle>
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
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
          <DialogHeader className="-mx-4 -mt-4 flex-row items-center gap-3 border-b p-4">
            <Avatar size="sm" className="rounded-lg after:rounded-lg after:border-0">
              <AvatarFallback className="rounded-lg [&>svg]:size-3.5">
                {form.transport === 'stdio' ? <SquareTerminal /> : <Globe />}
              </AvatarFallback>
            </Avatar>
            <DialogTitle className="min-w-0 truncate text-sm">
              {server ? server.name : t('mcp.newServer')}
            </DialogTitle>
            <ToggleGroup
              type="single"
              spacing={0.5}
              size="xs"
              className="ml-auto shrink-0 border p-px"
              value={mode}
              disabled={busy}
              onValueChange={(next) => {
                if ((next === 'json' || next === 'form') && next !== mode) changeMode(next)
              }}
              aria-label={t('mcp.editorMode')}
            >
              <ToggleGroupItem value="form">{t('mcp.form')}</ToggleGroupItem>
              <ToggleGroupItem value="json">{t('mcp.json')}</ToggleGroupItem>
            </ToggleGroup>
          </DialogHeader>
        )}
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-auto p-1">
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
            <ManualMcpFields
              form={form}
              change={setForm}
              name={name}
              changeName={setName}
              editing={!!server}
              disabled={busy}
              json={mode === 'json' ? { value: json, change: setJson } : undefined}
            />
          )}
          {feedback ? (
            <Alert variant="destructive">
              <AlertDescription>{feedback}</AlertDescription>
            </Alert>
          ) : null}
          {conflictBlock}
        </div>
        <DialogFooter className="items-center py-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={
              busy ||
              !!missing ||
              (!!conflicts.length && !replace) ||
              (!recipe && mode === 'json' && !json.trim()) ||
              // A form entry with no address could never connect; JSON may still hold a full object.
              (!recipe &&
                mode === 'form' &&
                !(
                  name.trim() &&
                  (form.transport === 'http' ? form.url.trim() : form.commandLine.trim())
                ))
            }
            onClick={save}
          >
            {t(server ? 'mcp.save' : 'mcp.addServer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
