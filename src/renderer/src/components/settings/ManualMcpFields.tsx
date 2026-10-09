/** Name, transport and editable key/value rows for manually configured MCP servers. */
import { Plus, X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import type { McpFormPair, McpManualForm } from '../../lib/mcp-form'
import { Button } from '../ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

const ROW =
  'col-span-2 grid grid-cols-subgrid items-start gap-x-3 *:data-[slot=field-label]:justify-self-end *:data-[slot=field-label]:pt-1.5 *:data-[slot=field-label]:whitespace-nowrap *:data-[slot=field-label]:text-right'

function PairFields({
  rows,
  change,
  keyLabel,
  disabled
}: {
  rows: McpFormPair[]
  change(rows: McpFormPair[]): void
  keyLabel: string
  disabled: boolean
}) {
  const t = useT()
  const update = (index: number, patch: Partial<McpFormPair>) =>
    change(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex min-w-0 items-center gap-2">
          <Input
            aria-label={`${keyLabel} ${index + 1}`}
            placeholder={keyLabel}
            className="min-w-0 flex-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input
            aria-label={`${t('mcp.pairValue')} ${index + 1}`}
            placeholder={t('mcp.pairValue')}
            className="min-w-0 flex-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`${t('mcp.removePair')} ${index + 1}`}
            onClick={() => change(rows.filter((_, i) => i !== index))}
          >
            <X data-icon="inline-start" />
          </Button>
        </div>
      ))}
      <Button
        className="self-start"
        variant="ghost"
        disabled={disabled}
        aria-label={t('mcp.addPair', { field: keyLabel })}
        onClick={() => change([...rows, { key: '', value: '' }])}
      >
        <Plus data-icon="inline-start" />
        {t('mcp.addServer')}
      </Button>
    </div>
  )
}

export function ManualMcpFields({
  form,
  change,
  name,
  changeName,
  editing,
  disabled,
  json
}: {
  form: McpManualForm
  change(form: McpManualForm): void
  name: string
  changeName(name: string): void
  editing: boolean
  disabled: boolean
  json?: { value: string; change(value: string): void }
}) {
  const t = useT()
  return (
    <FieldGroup className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-4">
      <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
        <FieldLabel htmlFor="mcp-name">{t('mcp.name')}</FieldLabel>
        <FieldContent className="min-w-0">
          <Input
            id="mcp-name"
            autoFocus={!editing}
            disabled={disabled}
            readOnly={editing}
            placeholder={t('mcp.namePlaceholder')}
            spellCheck={false}
            value={name}
            onChange={(event) => changeName(event.target.value)}
          />
          <FieldDescription className="text-xs">{t('mcp.nameDescription')}</FieldDescription>
        </FieldContent>
      </Field>
      {json ? (
        <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
          <FieldLabel htmlFor="mcp-json">JSON</FieldLabel>
          <FieldContent className="min-w-0">
            <Textarea
              id="mcp-json"
              className="font-mono"
              disabled={disabled}
              rows={10}
              spellCheck={false}
              placeholder={JSON.stringify(
                form.transport === 'http'
                  ? { type: 'http', url: '', headers: {} }
                  : { type: 'stdio', command: '', args: [], env: {} },
                null,
                2
              )}
              value={json.value}
              onChange={(event) => json.change(event.target.value)}
            />
            <FieldDescription className="text-xs">{t('mcp.configHint')}</FieldDescription>
          </FieldContent>
        </Field>
      ) : (
        <>
          <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
            <FieldLabel id="mcp-transport-label">{t('mcp.transport')}</FieldLabel>
            <FieldContent className="min-w-0">
              <ToggleGroup
                type="single"
                spacing={0.5}
                size="xs"
                className="mt-0.5 self-start border p-px"
                aria-labelledby="mcp-transport-label"
                value={form.transport}
                disabled={disabled}
                onValueChange={(transport) => {
                  if (transport === 'stdio' || transport === 'http') change({ ...form, transport })
                }}
              >
                <ToggleGroupItem value="stdio">{t('mcp.stdio')}</ToggleGroupItem>
                <ToggleGroupItem value="http">{t('mcp.http')}</ToggleGroupItem>
              </ToggleGroup>
            </FieldContent>
          </Field>
          {form.transport === 'stdio' ? (
            <>
              <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
                <FieldLabel htmlFor="mcp-command">{t('mcp.command')}</FieldLabel>
                <FieldContent className="min-w-0">
                  <Input
                    id="mcp-command"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    placeholder="npx -y @modelcontextprotocol/server-github"
                    value={form.commandLine}
                    onChange={(event) => change({ ...form, commandLine: event.target.value })}
                  />
                  <FieldDescription className="text-xs">
                    {t('mcp.commandDescription')}
                  </FieldDescription>
                </FieldContent>
              </Field>
              <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
                <FieldLabel>{t('mcp.env')}</FieldLabel>
                <FieldContent className="min-w-0">
                  <PairFields
                    rows={form.env}
                    change={(env) => change({ ...form, env })}
                    keyLabel={t('mcp.envKey')}
                    disabled={disabled}
                  />
                  <FieldDescription className="text-xs">
                    {t('mcp.pairDescription', { ref: '${NAME}' })}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </>
          ) : (
            <>
              <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
                <FieldLabel htmlFor="mcp-url">{t('mcp.url')}</FieldLabel>
                <FieldContent className="min-w-0">
                  <Input
                    id="mcp-url"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    placeholder="https://example.com/mcp"
                    value={form.url}
                    onChange={(event) => change({ ...form, url: event.target.value })}
                  />
                </FieldContent>
              </Field>
              <Field orientation="horizontal" className={ROW} data-disabled={disabled}>
                <FieldLabel>{t('mcp.headers')}</FieldLabel>
                <FieldContent className="min-w-0">
                  <PairFields
                    rows={form.headers}
                    change={(headers) => change({ ...form, headers })}
                    keyLabel={t('mcp.headerKey')}
                    disabled={disabled}
                  />
                  <FieldDescription className="text-xs">
                    {t('mcp.pairDescription', { ref: '${NAME}' })}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </>
          )}
        </>
      )}
    </FieldGroup>
  )
}
