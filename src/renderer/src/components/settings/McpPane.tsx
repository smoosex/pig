/** Added server rows and discovery share one pane; management details open without expanding rows. */
import { useEffect, useState } from 'react'
import {
  LogIn,
  LogOut,
  PlugZap,
  Plus,
  Search,
  Settings2,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import {
  api,
  type McpMarketResult,
  type McpMarketServer,
  type McpProbeResult,
  type McpServerView
} from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { listingText } from '../../lib/i18n'
import { useToolSettingsStore } from '../../stores/tool-settings'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Switch } from '../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { AddMcpDialog } from './AddMcpDialog'
import { McpIcon } from './McpIcon'
import { ToolSettingsFeedback } from './ToolSettingsFields'

function McpAction({
  label,
  hint,
  icon: Icon,
  disabled,
  onClick
}: {
  label: string
  hint?: string
  icon: LucideIcon
  disabled: boolean
  onClick(): void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon data-icon="inline-start" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint ? <span>{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

function McpProbeStatus({ name, result }: { name: string; result: McpProbeResult }) {
  const t = useT()
  const status = t(result.state === 'needs-auth' ? 'mcp.needsAuth' : `mcp.${result.state}`)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" aria-label={`${t('mcp.tools')} ${name}`}>
          <Badge variant={result.state === 'failed' ? 'destructive' : 'secondary'}>
            {status} · {t('mcp.toolsCount', { n: result.tools.length })}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-80 flex-col gap-2 overflow-auto">
        <p className="text-sm font-medium">
          {name} · {status}
        </p>
        {result.message ? (
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {result.message}
          </p>
        ) : null}
        {result.tools.length ? (
          <ul className="flex flex-col gap-2 text-xs">
            {result.tools.map((tool) => (
              <li key={tool.name}>
                <span className="font-mono">{tool.name}</span>
                {tool.description ? (
                  <p className="text-muted-foreground">{tool.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export function McpPane() {
  const t = useT()
  const state = useToolSettingsStore((s) => s.state)
  const busy = useToolSettingsStore((s) => s.busy)
  const run = useToolSettingsStore((s) => s.run)
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState<McpMarketResult>({ servers: [] })
  const [searching, setSearching] = useState(false)
  const [dialog, setDialog] = useState<{
    recipe?: McpMarketServer
    server?: McpServerView
    importJson?: boolean
  }>()
  const [removing, setRemoving] = useState<string>()
  const [login, setLogin] = useState<string>()
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({})
  useEffect(() => {
    let current = true
    const timer = window.setTimeout(
      () => {
        setSearching(true)
        void api
          .searchMcpMarket(query)
          .then((result) => {
            if (current) setMarket(result)
          })
          .catch((error) => {
            if (current) setMarket({ servers: [], error: String(error) })
          })
          .finally(() => {
            if (current) setSearching(false)
          })
      },
      query ? 350 : 0
    )
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [query])
  const probe = (name: string, authenticate = false) => {
    if (authenticate) setLogin(name)
    void run(() => (authenticate ? api.loginMcpServer(name) : api.testMcpServer(name)))
      .then((result) => {
        if (result) setProbes((old) => ({ ...old, [name]: result }))
      })
      .finally(() => setLogin(undefined))
  }
  return (
    <div className="flex flex-col gap-5">
      <ToolSettingsFeedback />
      <section className="flex flex-col gap-3" aria-labelledby="mcp-installed">
        <div className="flex items-center justify-between gap-2">
          <h3 id="mcp-installed" className="text-xs font-medium text-muted-foreground">
            {t('mcp.installed')}
          </h3>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setDialog({ importJson: true })}
          >
            {t('mcp.import')}
          </Button>
        </div>
        {login ? (
          <Button
            className="self-start"
            variant="outline"
            onClick={() => void api.cancelMcpLogin()}
          >
            {t('mcp.cancelLogin')}
          </Button>
        ) : null}
        {!state.servers.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('mcp.empty')}</EmptyTitle>
              <EmptyDescription>{t('mcp.emptyDescription')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {state.servers.map((server) => {
          const oauth =
            'url' in server.config &&
            !server.config.auth &&
            !Object.keys(server.config.headers ?? {}).some(
              (key) => key.toLowerCase() === 'authorization'
            )
          const invocation =
            'url' in server.config
              ? server.config.url
              : [server.config.command, ...(server.config.args ?? [])].join(' ')
          const result = probes[server.name]
          return (
            <Card key={server.name} className="gap-3 py-3">
              <CardHeader className="flex flex-row items-center gap-3">
                <McpIcon source={server.icon} name={server.name} className="size-10" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <CardTitle className="min-w-0 truncate text-sm">{server.name}</CardTitle>
                    {result ? <McpProbeStatus name={server.name} result={result} /> : null}
                  </div>
                  <CardDescription className="truncate text-xs" title={invocation}>
                    {invocation}
                  </CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <McpAction
                    label={`${t('mcp.edit')} ${server.name}`}
                    icon={Settings2}
                    disabled={busy}
                    onClick={() => setDialog({ server })}
                  />
                  <McpAction
                    label={`${t('mcp.test')} ${server.name}`}
                    hint={t('mcp.testDescription')}
                    icon={PlugZap}
                    disabled={busy}
                    onClick={() => probe(server.name)}
                  />
                  {server.authenticated ? (
                    <McpAction
                      label={`${t('mcp.logout')} ${server.name}`}
                      hint={t('mcp.authenticated')}
                      icon={LogOut}
                      disabled={busy}
                      onClick={() =>
                        void run(() => api.logoutMcpServer(server.name)).then((result) => {
                          if (result)
                            setProbes((old) => {
                              const next = { ...old }
                              delete next[server.name]
                              return next
                            })
                        })
                      }
                    />
                  ) : oauth ? (
                    <McpAction
                      label={`${t('mcp.login')} ${server.name}`}
                      icon={LogIn}
                      disabled={busy}
                      onClick={() => probe(server.name, true)}
                    />
                  ) : null}
                  <McpAction
                    label={`${t('mcp.remove')} ${server.name}`}
                    icon={Trash2}
                    disabled={busy}
                    onClick={() => setRemoving(server.name)}
                  />
                  <Switch
                    className="ml-2"
                    checked={server.config.enabled === true}
                    disabled={busy}
                    aria-label={`${t('mcp.enabled')} ${server.name}`}
                    onCheckedChange={(value) =>
                      void run(() => api.setMcpEnabled(server.name, value))
                    }
                  />
                </div>
              </CardHeader>
            </Card>
          )
        })}
        <Button
          className="self-start"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setDialog({})}
        >
          <Plus data-icon="inline-start" />
          {t('mcp.add')}
        </Button>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="mcp-market">
        <h3 id="mcp-market" className="text-xs font-medium text-muted-foreground">
          {t('mcp.market')}
        </h3>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t('mcp.search')}
            placeholder={t('mcp.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        {market.error ? (
          <Alert>
            <AlertDescription>{market.error}</AlertDescription>
          </Alert>
        ) : null}
        {searching ? <p className="text-sm text-muted-foreground">{t('mcp.loading')}</p> : null}
        {!searching && !market.servers.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('mcp.noMatches')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          {market.servers.map((server) => {
            const added = state.servers.some((entry) => entry.name === server.name)
            return (
              <Card key={server.id} className="gap-3">
                <CardHeader className="grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <McpIcon
                    source={server.icon}
                    name={server.title || server.name}
                    className="mt-1 row-span-2 size-10"
                  />
                  <CardTitle className="truncate text-sm">{server.title}</CardTitle>
                  <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    {server.publisher ? <span className="truncate">{server.publisher}</span> : null}
                    <Badge variant="secondary">
                      {'url' in server.config ? t('mcp.remote') : server.config.command}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="line-clamp-2 text-sm text-muted-foreground">
                  {listingText(t, server.descriptionKey, server.description)}
                </CardContent>
                <CardFooter className="mt-auto justify-between gap-2 py-3">
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {server.name}
                  </span>
                  <Button
                    size="sm"
                    variant={added ? 'ghost' : 'outline'}
                    disabled={busy || added}
                    onClick={() => setDialog({ recipe: server })}
                    aria-label={t('mcp.addRecipe', { name: server.title })}
                  >
                    {t(added ? 'mcp.added' : 'mcp.add')}
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      </section>
      {dialog ? <AddMcpDialog {...dialog} onClose={() => setDialog(undefined)} /> : null}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(undefined)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t('mcp.removeTitle', { name: removing ?? '' })}
            </DialogTitle>
            <DialogDescription className="text-xs">{t('mcp.removeDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (removing)
                  void run(() => api.removeMcpServer(removing)).then((result) => {
                    if (result) setRemoving(undefined)
                  })
              }}
            >
              {t('mcp.remove')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
