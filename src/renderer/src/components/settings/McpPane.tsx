/** Added server rows and discovery share one pane; management details open without expanding rows. */
import { useEffect, useRef, useState } from 'react'
import {
  LoaderCircle,
  LogOut,
  Plus,
  Radar,
  Search,
  Settings,
  Trash2,
  Verified,
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
import { cn } from '../../lib/utils'
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
  name,
  hint,
  icon: Icon,
  disabled,
  onClick
}: {
  label: string
  name: string
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
          aria-label={`${label} ${name}`}
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
  const tools = t('mcp.toolsCount', { n: result.tools.length })
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent"
          aria-label={`${status} · ${tools} · ${name}`}
        >
          <Badge variant="secondary">
            <span
              aria-hidden="true"
              className={cn('size-1.5 shrink-0 rounded-full', {
                'bg-success': result.state === 'ready',
                'bg-destructive': result.state === 'failed',
                'bg-warning': result.state === 'needs-auth'
              })}
            />
            {tools}
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
  const loaded = useToolSettingsStore((s) => s.loaded)
  const loading = useToolSettingsStore((s) => s.loading)
  const error = useToolSettingsStore((s) => s.error)
  const load = useToolSettingsStore((s) => s.load)
  const run = useToolSettingsStore((s) => s.run)
  useEffect(() => { void load() }, [load])
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState<McpMarketResult>({ servers: [] })
  const [searching, setSearching] = useState(false)
  const [dialog, setDialog] = useState<{
    recipe?: McpMarketServer
    server?: McpServerView
  }>()
  const [removing, setRemoving] = useState<string>()
  const [login, setLogin] = useState<string>()
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({})
  const activeProbes = useRef(new Set<string>())
  const [testing, setTesting] = useState(() => new Set<string>())
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
    // Claim synchronously; repeat clicks can arrive before React disables the row.
    if (activeProbes.current.has(name) || useToolSettingsStore.getState().busy) return
    activeProbes.current.add(name)
    setTesting(new Set(activeProbes.current))
    if (authenticate) setLogin(name)
    void run(() => (authenticate ? api.loginMcpServer(name) : api.testMcpServer(name)), {
      blocking: authenticate
    })
      .then((result) => {
        if (result) setProbes((old) => ({ ...old, [name]: result }))
      })
      .finally(() => {
        activeProbes.current.delete(name)
        setTesting(new Set(activeProbes.current))
        if (authenticate) setLogin(undefined)
      })
  }
  return (
    <div className="flex flex-col gap-5">
      <ToolSettingsFeedback />
      <section className="flex flex-col gap-3" aria-labelledby="mcp-installed">
        <div className="flex items-center justify-between gap-2">
          <h3 id="mcp-installed" className="text-xs font-medium text-muted-foreground">
            {t('mcp.installed')}
          </h3>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog({})}>
            <Plus data-icon="inline-start" />
            {t('mcp.add')}
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
        {loading || (!loaded && !error) ? (
          <p role="status" className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />{t('mcp.loading')}
          </p>
        ) : null}
        {error && !loading ? <Button variant="outline" size="sm" className="self-start" onClick={() => void load()}>{t('common.retry')}</Button> : null}
        {loaded && !loading && !error && !state.servers.length ? (
          <Empty className="min-h-40 border">
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
          const isTesting = testing.has(server.name)
          const rowBusy = busy || isTesting
          return (
            <Card key={server.name} className="gap-3 py-3">
              <CardHeader className="flex flex-row items-center gap-3">
                <McpIcon source={server.icon} name={server.name} className="size-10" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <CardTitle className="min-w-0 truncate text-sm">{server.name}</CardTitle>
                    {isTesting ? (
                      <span
                        role="status"
                        aria-label={`${t('mcp.testing')} ${server.name}`}
                        className="inline-flex h-6 shrink-0 items-center border border-transparent px-2"
                      >
                        <Badge variant="secondary">
                          <LoaderCircle
                            data-icon="inline-start"
                            aria-hidden="true"
                            className="animate-spin"
                          />
                          {t('mcp.testing')}
                        </Badge>
                      </span>
                    ) : result ? (
                      <McpProbeStatus name={server.name} result={result} />
                    ) : null}
                  </div>
                  <CardDescription className="truncate text-xs" title={invocation}>
                    {invocation}
                  </CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <McpAction
                    label={t('mcp.edit')}
                    name={server.name}
                    icon={Settings}
                    disabled={rowBusy}
                    onClick={() => setDialog({ server })}
                  />
                  <McpAction
                    label={t('mcp.test')}
                    name={server.name}
                    icon={Radar}
                    disabled={rowBusy}
                    onClick={() => probe(server.name)}
                  />
                  {server.authenticated ? (
                    <McpAction
                      label={t('mcp.logout')}
                      name={server.name}
                      hint={t('mcp.authenticated')}
                      icon={LogOut}
                      disabled={rowBusy}
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
                      label={t('mcp.login')}
                      name={server.name}
                      icon={Verified}
                      disabled={rowBusy}
                      onClick={() => probe(server.name, true)}
                    />
                  ) : null}
                  <McpAction
                    label={t('mcp.remove')}
                    name={server.name}
                    icon={Trash2}
                    disabled={rowBusy}
                    onClick={() => setRemoving(server.name)}
                  />
                  <Switch
                    className="ml-2"
                    checked={server.config.enabled === true}
                    disabled={rowBusy}
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
        <div className="grid gap-3 sm:grid-cols-2">
          {market.servers.map((server) => {
            const added = state.servers.some((entry) => entry.name === server.name)
            const description = listingText(t, server.descriptionKey, server.description)
            const byline = server.publisher || server.name
            return (
              <Card key={server.id} className="min-w-0 gap-4">
                <CardHeader className="gap-3">
                  <div className="flex items-center gap-3">
                    <McpIcon
                      source={server.icon}
                      name={server.title || server.name}
                      className="size-8 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate text-sm leading-tight" title={server.title}>
                        {server.title}
                      </CardTitle>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={byline}>
                        {byline}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                {description ? (
                  <CardContent>
                    <CardDescription className="line-clamp-3 text-xs leading-relaxed">
                      {description}
                    </CardDescription>
                  </CardContent>
                ) : null}
                <CardFooter className="mt-auto flex-wrap gap-2">
                  <span className="flex min-w-0 flex-1">
                    <Badge variant="secondary" className="max-w-full truncate">
                      {'url' in server.config ? t('mcp.remote') : server.config.command}
                    </Badge>
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || added}
                    onClick={() => setDialog({ recipe: server })}
                    aria-label={t('mcp.addRecipe', { name: server.title })}
                  >
                    {!added ? <Plus data-icon="inline-start" /> : null}
                    {t(added ? 'mcp.added' : 'mcp.addServer')}
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
