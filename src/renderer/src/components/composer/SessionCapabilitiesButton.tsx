/** Per-session resource switches; the main process owns defaults, persistence and runtime reloads. */
import { useEffect, useId, useRef, useState } from 'react'
import { Ban, CheckCheck, ChevronRight, Cog, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import type { CapabilityGroup, SessionCapabilities, SessionCapability } from '../../../../shared/session-capabilities'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { InputGroupButton } from '../ui/input-group'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover'
import { Switch } from '../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn, hideScroll } from '../../lib/utils'

export function SessionCapabilitiesButton({ sessionId, busy }: { sessionId: string | null; busy: boolean }) {
  const t = useT()
  const prefix = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<CapabilityGroup>('tools')
  const [state, setState] = useState<SessionCapabilities | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !sessionId) return
    let alive = true
    const load = () => {
      void api.getSessionCapabilities(sessionId).then((next) => {
        if (alive) { setState(next); setError(null) }
      }, (failure) => { if (alive) setError(String(failure)) })
    }
    load()
    const offMcp = api.onMcpChanged(load)
    const offSkills = api.onSkillsChanged(load)
    return () => { alive = false; offMcp(); offSkills() }
  }, [open, sessionId, busy])

  async function update(group: CapabilityGroup, id: string | null, enabled: boolean | null) {
    if (!sessionId) return
    setPending(true)
    try { setState(await api.setSessionCapability(sessionId, group, id, enabled)) }
    catch (failure) { toast.error(String(failure)) }
    finally { setPending(false) }
  }
  const disabled = pending || busy || state?.busy
  const bulkActions = [
    { icon: CheckCheck, label: t('composer.capabilitiesEnableAll'), enabled: true },
    { icon: Ban, label: t('composer.capabilitiesDisableAll'), enabled: false },
    { icon: RotateCcw, label: t('composer.capabilitiesReset'), enabled: null }
  ] as const
  const groups = [
    ['tools', t('composer.capabilitiesTools')],
    ['mcp', t('composer.capabilitiesMcp')],
    ['skills', t('composer.capabilitiesSkills')]
  ] as const
  const sourceLabels = {
    pi: t('composer.capabilitiesSourcePi'), agents: t('composer.capabilitiesSourceAgents'),
    project: t('composer.capabilitiesSourceProject'), claude: t('skills.agentClaude'),
    codex: t('skills.agentCodex'), imported: t('skills.managed')
  }
  const skillGroups = new Map<string, { label: string; items: SessionCapability[] }>()
  for (const item of state?.skills ?? []) {
    const source = item.source
    const key = source ? `${source.kind}:${source.name ?? ''}` : 'other'
    const label = source?.name?.replace(/^https:\/\/github\.com\//, '')
      || (source ? sourceLabels[source.kind] : t('composer.capabilitiesSourceOther'))
    const group = skillGroups.get(key) ?? { label, items: [] }
    group.items.push(item)
    skillGroups.set(key, group)
  }
  // Tags are identifiers, not prose, so they stay untranslated.
  const provider = (item: SessionCapability) => item.provider?.kind === 'pi' ? 'built-in' : item.provider?.name ?? 'plugin'
  const row = (group: CapabilityGroup, item: SessionCapability) => {
    const id = `${prefix}-${group}-${encodeURIComponent(item.id)}`
    const description = item.description?.trim() || t('composer.capabilitiesNoDescription')
    return (
      <Field key={item.id} orientation="horizontal">
        <FieldContent className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <FieldLabel htmlFor={id} className="block min-w-0 truncate text-xs font-normal" title={item.name}>{item.name}</FieldLabel>
            {item.provider ? <Badge variant="secondary" className="min-w-0 max-w-1/2 font-normal" title={provider(item)}><span className="truncate">{provider(item)}</span></Badge> : null}
          </div>
          <FieldDescription id={`${id}-description`} className="line-clamp-2 wrap-anywhere text-xs font-normal" title={description}>{description}</FieldDescription>
        </FieldContent>
        {item.overridden ? (
          <Button size="icon-xs" variant="ghost" disabled={disabled} title={t('composer.capabilitiesReset')} aria-label={`${item.name}: ${t('composer.capabilitiesReset')}`} onClick={() => void update(group, item.id, null)}>
            <RotateCcw />
          </Button>
        ) : null}
        <Switch id={id} aria-describedby={`${id}-description`} checked={item.enabled} disabled={disabled} onCheckedChange={(checked) => void update(group, item.id, checked)} />
      </Field>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InputGroupButton size="icon-xs" variant="ghost" className="rounded-full [&_svg:not([class*='size-'])]:size-3" disabled={!sessionId} aria-label={t('composer.capabilities')} title={t('composer.capabilities')}>
          <Cog />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        tabIndex={-1}
        side="top"
        align="start"
        className="w-88 max-w-[calc(100vw-2rem)] text-xs font-normal"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          contentRef.current?.focus({ preventScroll: true })
        }}
      >
        <PopoverHeader>
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle className="text-xs font-normal">{t('composer.capabilities')}</PopoverTitle>
            <div className="flex shrink-0 items-center gap-0.5">
              {bulkActions.map(({ icon: Icon, label, enabled }) => (
                <Tooltip key={label}>
                  <TooltipTrigger asChild>
                    <Button size="icon-xs" variant="ghost" aria-label={label} disabled={disabled || !state?.[tab].length} onClick={() => void update(tab, null, enabled)}>
                      <Icon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
          <PopoverDescription className="text-xs font-normal">{t('composer.capabilitiesHint')}</PopoverDescription>
        </PopoverHeader>
        {busy || state?.busy ? <p className="text-xs text-muted-foreground">{t('composer.capabilitiesBusy')}</p> : null}
        {error ? <p role="alert" className="text-xs font-normal text-destructive">{error}</p> : null}
        {!state && !error ? <p role="status">{t('composer.capabilitiesLoading')}</p> : null}
        {state ? <Tabs value={tab} onValueChange={(value) => setTab(value as CapabilityGroup)} className="min-w-0 gap-3" aria-busy={pending}>
          {groups.map(([group]) => (
            <TabsContent key={group} value={group} className={cn('h-80 overflow-x-hidden overflow-y-auto p-1', hideScroll)}>
              <FieldGroup>
                {state[group].length === 0 ? <p className="text-xs text-muted-foreground">{t('composer.capabilitiesEmpty')}</p> : null}
                {group === 'skills' ? [...skillGroups].map(([key, source]) => (
                  <Collapsible key={key} defaultOpen className="flex min-w-0 flex-col gap-3">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" className="group h-8 w-full justify-start border-0 px-1 py-0 text-left text-xs font-normal">
                        <ChevronRight className="shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                        <span className="flex h-full min-w-0 flex-1 items-center"><span className="truncate" title={source.label}>{source.label}</span></span>
                        <span className="flex h-full shrink-0 items-center text-muted-foreground">{source.items.length}</span>
                      </Button>
                    </CollapsibleTrigger>
                    {/* 9px: the header padding plus the whitespace inside the 16px chevron, so rows start under its glyph. */}
                    <CollapsibleContent><FieldGroup className="pr-1 pl-2.25">{source.items.map((item) => row('skills', item))}</FieldGroup></CollapsibleContent>
                  </Collapsible>
                )) : state[group].map((item) => row(group, item))}
              </FieldGroup>
            </TabsContent>
          ))}
          <TabsList className="w-full shrink-0" aria-label={t('composer.capabilities')}>
            {groups.map(([group, title]) => <TabsTrigger key={group} value={group} className="flex-1 text-xs font-normal">{title}</TabsTrigger>)}
          </TabsList>
        </Tabs> : null}
      </PopoverContent>
    </Popover>
  )
}
