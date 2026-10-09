import { useEffect, useState } from 'react'
import { LogIn, Plus, Search, Trash2 } from 'lucide-react'
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Switch } from '../ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { AddMcpDialog } from './AddMcpDialog'
import { McpIcon } from './McpIcon'
import { ToolSettingsFeedback } from './ToolSettingsFields'

export function McpPane() {
  const t = useT()
  const state = useToolSettingsStore((s) => s.state)
  const busy = useToolSettingsStore((s) => s.busy)
  const run = useToolSettingsStore((s) => s.run)
  const [tab, setTab] = useState('installed')
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          value={tab}
          variant="outline"
          onValueChange={(value) => {
            if (value) setTab(value)
          }}
        >
          <ToggleGroupItem value="installed">{t('mcp.installed')}</ToggleGroupItem>
          <ToggleGroupItem value="market">{t('mcp.market')}</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setDialog({ importJson: true })}
          >
            {t('mcp.import')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => setDialog({})}>
            <Plus data-icon="inline-start" />
            {t('mcp.add')}
          </Button>
        </div>
      </div>
      {login ? (
        <Button variant="outline" onClick={() => void api.cancelMcpLogin()}>
          {t('mcp.cancelLogin')}
        </Button>
      ) : null}
      {tab === 'installed' ? (
        <>
          <p className="text-xs text-muted-foreground">{t('mcp.testDescription')}</p>
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
            const result = probes[server.name]
            return (
              <Card key={server.name}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="flex min-w-0 items-center gap-2">
                      <McpIcon source={server.icon} name={server.name} />
                      <span className="truncate">{server.name}</span>
                    </CardTitle>
                    <Switch
                      checked={server.config.enabled === true}
                      disabled={busy}
                      aria-label={`${t('mcp.enabled')} ${server.name}`}
                      onCheckedChange={(value) =>
                        void run(() => api.setMcpEnabled(server.name, value))
                      }
                    />
                  </div>
                  <CardDescription>
                    {server.config.description
                      ? listingText(t, server.descriptionKey, server.config.description)
                      : 'url' in server.config
                        ? t('mcp.remote')
                        : server.config.command}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {'url' in server.config
                      ? server.config.url
                      : [server.config.command, ...(server.config.args ?? [])].join(' ')}
                  </p>
                  {server.authenticated ? (
                    <Badge variant="secondary" className="w-fit">
                      {t('mcp.authenticated')}
                    </Badge>
                  ) : null}
                  {result ? (
                    <>
                      <Badge
                        className="w-fit"
                        variant={result.state === 'failed' ? 'destructive' : 'secondary'}
                      >
                        {t(result.state === 'needs-auth' ? 'mcp.needsAuth' : `mcp.${result.state}`)}{' '}
                        · {t('mcp.toolsCount', { n: result.tools.length })}
                      </Badge>
                      {result.message ? (
                        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {result.message}
                        </p>
                      ) : null}
                      {result.tools.length ? (
                        <Collapsible>
                          <CollapsibleTrigger asChild>
                            <Button size="sm" variant="ghost">
                              {t('mcp.tools')}
                            </Button>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <ul className="mt-2 flex flex-col gap-1 text-xs">
                              {result.tools.map((tool) => (
                                <li key={tool.name}>
                                  <span className="font-mono">{tool.name}</span>
                                  {tool.description ? (
                                    <p className="text-muted-foreground">{tool.description}</p>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </CollapsibleContent>
                        </Collapsible>
                      ) : null}
                    </>
                  ) : null}
                </CardContent>
                <CardFooter className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDialog({ server })}
                  >
                    {t('mcp.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => probe(server.name)}
                  >
                    {t('mcp.test')}
                  </Button>
                  {oauth ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => probe(server.name, true)}
                    >
                      <LogIn data-icon="inline-start" />
                      {t('mcp.login')}
                    </Button>
                  ) : null}
                  {server.authenticated ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => api.logoutMcpServer(server.name)).then(() =>
                          setProbes((old) => {
                            const next = { ...old }
                            delete next[server.name]
                            return next
                          })
                        )
                      }
                    >
                      {t('mcp.logout')}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setRemoving(server.name)}
                  >
                    <Trash2 data-icon="inline-start" />
                    {t('mcp.remove')}
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </>
      ) : (
        <>
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
          <p className="text-xs text-muted-foreground">{t('mcp.source')}</p>
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
                      className="row-span-2 size-9"
                    />
                    <CardTitle className="truncate">{server.title}</CardTitle>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      {server.publisher ? (
                        <span className="truncate">{server.publisher}</span>
                      ) : null}
                      <Badge variant="secondary">
                        {'url' in server.config ? t('mcp.remote') : server.config.command}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="line-clamp-2 text-sm text-muted-foreground">
                    {listingText(t, server.descriptionKey, server.description)}
                  </CardContent>
                  <CardFooter className="justify-between gap-2">
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
        </>
      )}
      {dialog ? <AddMcpDialog {...dialog} onClose={() => setDialog(undefined)} /> : null}
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('mcp.removeTitle', { name: removing ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('mcp.removeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                if (removing)
                  void run(() => api.removeMcpServer(removing)).then((result) => {
                    if (result) setRemoving(undefined)
                  })
              }}
            >
              {t('mcp.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
