/** Global inventory includes local references, remote copies and automatically discovered files. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, ChevronRight, Copy, FolderOpen, Info, LoaderCircle, MoreHorizontal, Plus, RotateCw, Search, Trash2 } from 'lucide-react'
import { api, type SkillInfo, type SkillInventory } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Alert, AlertDescription } from '../ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Switch } from '../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { SettingsCard } from './SettingsFields'
import { McpIcon } from './McpIcon'
import { AddSkillDialog, type AddSkillSource } from './AddSkillDialog'
import { SkillDetailsDialog } from './SkillDetailsDialog'
import { SkillsDiscover } from './SkillsDiscover'

import type { SkillUpdateCheck } from '../../../../shared/skills'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function SkillUpdateActions({ skill, onUpdated, disabled }: { skill: SkillInfo; onUpdated(): Promise<void>; disabled: boolean }) {
  const t = useT()
  const [check, setCheck] = useState<SkillUpdateCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const working = useRef(false)
  const run = async (update: boolean) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      if (update) {
        await api.updateSkill(skill.id)
        setCheck(null)
        await onUpdated()
      } else {
        setCheck(null)
        setCheck(await api.checkSkillUpdate(skill.id))
      }
    } catch (failure) { setError(errorText(failure)) }
    finally { working.current = false; setBusy(false) }
  }
  return <div className="mt-2 flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="outline" disabled={disabled || busy} onClick={() => void run(false)}>
        {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}{t('skills.checkUpdate')}
      </Button>
      {check?.available ? <Button size="xs" variant="outline" disabled={disabled || busy} onClick={() => void run(true)}>{t('skills.update')}</Button> : null}
    </div>
    {check ? <p role="status" className="break-words text-xs text-muted-foreground">{check.available ? t('skills.updateAvailable', { current: check.currentCommit, latest: check.latestCommit }) : t('skills.upToDate')}</p> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
  </div>
}

export function SkillsPane() {
  const t = useT()
  const [inventory, setInventory] = useState<SkillInventory>({ skills: [], diagnostics: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('installed')
  const [add, setAdd] = useState<AddSkillSource | null>(null)
  const [detail, setDetail] = useState<SkillInfo | null>(null)
  const [remove, setRemove] = useState<SkillInfo | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const active = useRef(new Set<string>())
  const request = useRef(0)
  const load = useCallback(async () => {
    const current = ++request.current
    try {
      const next = await api.listSkills()
      if (current === request.current) { setInventory(next); setLoadError(null) }
    } catch (failure) { if (current === request.current) setLoadError(errorText(failure)) }
    finally { if (current === request.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    const off = api.onSkillsChanged(() => { void load() })
    return () => { request.current++; off() }
  }, [load])
  const run = async (id: string, operation: () => Promise<unknown>) => {
    if (active.current.has(id)) return
    active.current.add(id)
    setPending(new Set(active.current))
    setError(null)
    try { await operation(); await load() }
    catch (failure) { setError(errorText(failure)) }
    finally { active.current.delete(id); setPending(new Set(active.current)) }
  }
  const q = query.trim().toLowerCase()
  const shown = inventory.skills.filter((skill) => !q || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(q))
  const managed = shown.filter((skill) => skill.managed)
  const discovered = shown.filter((skill) => !skill.managed && !skill.agent)
  const external = shown.filter((skill) => skill.agent)
  const groups = new Map<string, SkillInfo[]>()
  for (const skill of managed) {
    const list = groups.get(skill.source) ?? []
    list.push(skill)
    groups.set(skill.source, list)
  }
  const row = (skill: SkillInfo) => (
    <div key={skill.id} className="flex items-start gap-3 p-4">
      <McpIcon source={skill.icon} name={skill.name} fallback={<BookOpen className="size-4" />} className="mt-0.5 size-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="link" className="h-auto min-w-0 justify-start p-0 text-sm text-foreground" onClick={() => setDetail(skill)}><span className="truncate">{skill.name}</span></Button>
          {skill.manualOnly ? <Badge variant="secondary">{t('skills.manualOnly')}</Badge> : null}
          {!skill.available ? <Badge variant="destructive">{t('skills.unavailable')}</Badge> : null}
          {skill.available && skill.diagnostics.length ? <Badge variant="outline"><AlertTriangle />{t('skills.warning')}</Badge> : null}
        </div>
        {skill.description ? <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description}</p> : null}
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={skill.filePath}>{skill.filePath}</p>
        {skill.localReference ? <p className="mt-1 text-xs text-muted-foreground">{t('skills.localReferenceHint')}</p> : skill.managed && !skill.update ? <p className="mt-1 text-xs text-muted-foreground">{t('skills.snapshotHint')}</p> : null}
        {skill.kind === 'github' && skill.update ? <SkillUpdateActions key={`${skill.id}-${skill.update.commit}`} skill={skill} onUpdated={load} disabled={pending.has(skill.id)} /> : null}
        {skill.diagnostics.map((message) => <p key={message} className="mt-1 break-words text-xs text-warning">{message}</p>)}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch aria-label={t('skills.enable', { name: skill.name })} checked={skill.enabled} disabled={pending.has(skill.id) || (!skill.available && !skill.enabled)} onCheckedChange={(enabled) => void run(skill.id, () => api.setSkillEnabled(skill.id, enabled))} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={t('skills.more', { name: skill.name })} disabled={pending.has(skill.id)}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => setDetail(skill)}><BookOpen />{t('skills.view')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void run(skill.id, () => api.openSkillDirectory(skill.id))}><FolderOpen />{t('skills.openDirectory')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void run(skill.id, () => navigator.clipboard.writeText(skill.filePath))}><Copy />{t('skills.copyPath')}</DropdownMenuItem>
            </DropdownMenuGroup>
            {skill.managed ? <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem variant="destructive" onSelect={() => { setRemoveError(null); setRemove(skill) }}><Trash2 />{t('skills.remove')}</DropdownMenuItem></DropdownMenuGroup></> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label={t('skills.title')}>
            <TabsTrigger value="installed">{t('skills.installed')}<span className="text-muted-foreground">{inventory.skills.length}</span></TabsTrigger>
            <TabsTrigger value="discover">{t('skills.discover')}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="ghost" aria-label={t('skills.refresh')} disabled={loading} onClick={() => { setLoading(true); void load() }}>{loading ? <LoaderCircle className="animate-spin" /> : <RotateCw />}</Button>
            <Button size="sm" onClick={() => setAdd({ source: '' })}><Plus data-icon="inline-start" />{t('skills.add')}</Button>
          </div>
        </div>
        {error || loadError ? <Alert variant="destructive"><AlertDescription className="flex-row items-center justify-between gap-2"><span>{error ?? loadError}</span><Button variant="outline" size="xs" onClick={() => { setError(null); void load() }}>{t('common.retry')}</Button></AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        <TabsContent value="installed">
          <InputGroup>
            <InputGroupInput aria-label={t('skills.search')} placeholder={t('skills.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
            <InputGroupAddon><Search /></InputGroupAddon>
          </InputGroup>
          <p className="text-xs text-muted-foreground">{t('skills.count', { n: inventory.skills.length, enabled: inventory.skills.filter((skill) => skill.enabled && skill.available).length })}</p>
          {loading && !inventory.skills.length ? <p role="status" className="text-xs text-muted-foreground">{t('skills.loading')}</p> : null}
          {!loading && !shown.length ? <Empty className="min-h-52 border">
            <EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia><EmptyTitle>{t(q ? 'skills.noMatches' : 'skills.empty')}</EmptyTitle><EmptyDescription>{t(q ? 'skills.noMatchesDescription' : 'skills.emptyDescription')}</EmptyDescription></EmptyHeader>
            {!q ? <EmptyContent><Button size="sm" variant="outline" onClick={() => setTab('discover')}>{t('skills.discover')}</Button></EmptyContent> : null}
          </Empty> : null}
          {managed.length ? <section className="flex flex-col gap-3" aria-labelledby="skills-managed">
            <div><h2 id="skills-managed" className="text-xs font-medium">{t('skills.managed')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('skills.managedHint')}</p></div>
            {[...groups].map(([source, skills]) => <Collapsible key={source} defaultOpen className="flex flex-col gap-2">
              <CollapsibleTrigger asChild><Button variant="ghost" className="group h-auto justify-start gap-2 px-1 py-1.5 text-left text-xs"><ChevronRight className="transition-transform group-data-[state=open]:rotate-90" /><span className="min-w-0 flex-1 truncate" title={source}>{source.replace('https://github.com/', '')}</span><span className="shrink-0 text-muted-foreground">{t('skills.groupCount', { n: skills.length })}</span></Button></CollapsibleTrigger>
              <CollapsibleContent><SettingsCard>{skills.map(row)}</SettingsCard></CollapsibleContent>
            </Collapsible>)}
          </section> : null}
          {discovered.length ? <section className="flex flex-col gap-3" aria-labelledby="skills-discovered">
            <div><h2 id="skills-discovered" className="text-xs font-medium">{t('skills.discovered')}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('skills.discoveredHint')}</p></div>
            <SettingsCard>{discovered.map(row)}</SettingsCard>
          </section> : null}
          {external.length ? <section className="flex flex-col gap-3" aria-labelledby="skills-external">
            <div><h2 id="skills-external" className="text-xs font-medium">{t('skills.external')}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('skills.externalHint')}</p></div>
            {(['claude', 'codex'] as const).map((agent) => {
              const list = external.filter((skill) => skill.agent === agent)
              return list.length ? <Collapsible key={`${agent}-${q ? 'search' : 'idle'}`} defaultOpen={!!q} className="flex flex-col gap-2">
                <CollapsibleTrigger asChild><Button variant="ghost" className="group h-auto justify-start gap-2 px-1 py-1.5 text-left text-xs"><ChevronRight className="transition-transform group-data-[state=open]:rotate-90" /><span className="min-w-0 flex-1 truncate">{t(agent === 'claude' ? 'skills.agentClaude' : 'skills.agentCodex')}</span><span className="shrink-0 text-muted-foreground">{t('skills.groupCount', { n: list.length })}</span></Button></CollapsibleTrigger>
                <CollapsibleContent><SettingsCard>{list.map(row)}</SettingsCard></CollapsibleContent>
              </Collapsible> : null
            })}
          </section> : null}
          {inventory.diagnostics.length ? <Alert><AlertTriangle /><AlertDescription>{inventory.diagnostics.map((item, index) => <span key={index} className="break-words">{item.path}: {item.message}</span>)}</AlertDescription></Alert> : null}
          <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" /><div><p>{t('skills.scopeHint')}</p><p className="mt-1">{t('skills.reloadHint')}</p></div></div>
        </TabsContent>
        <TabsContent value="discover"><SkillsDiscover installed={inventory.skills.filter((skill) => !skill.agent)} onAdd={setAdd} /></TabsContent>
      </Tabs>
      {add ? <AddSkillDialog initial={add} onClose={() => setAdd(null)} onInstalled={(result) => {
        void load()
        setNotice(t('skills.installedCount', { n: result.installed.length }))
      }} /> : null}
      {detail ? <SkillDetailsDialog key={detail.id} skill={detail} onClose={() => setDetail(null)} /> : null}
      <AlertDialog open={!!remove} onOpenChange={(open) => { if (!open && !removing) setRemove(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('skills.removeTitle', { name: remove?.name ?? '' })}</AlertDialogTitle><AlertDialogDescription>{t(remove?.localReference ? 'skills.removeReferenceDescription' : 'skills.removeDescription')}</AlertDialogDescription></AlertDialogHeader>
          {removeError ? <Alert variant="destructive"><AlertDescription>{removeError}</AlertDescription></Alert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('skills.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removing} onClick={(event) => {
              event.preventDefault()
              if (!remove || removing) return
              setRemoving(true)
              setRemoveError(null)
              void api.removeSkill(remove.id).then(async () => { setRemove(null); await load() }, (failure) => setRemoveError(errorText(failure))).finally(() => setRemoving(false))
            }}>{t(removing ? 'skills.removing' : 'skills.remove')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
