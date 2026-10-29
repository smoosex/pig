/** A preview token owns the source snapshot; stale scans and closed dialogs release it in main. */
import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, FolderOpen, LoaderCircle, Search } from 'lucide-react'
import { api, type SkillInstallResult, type SkillProbe } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { PathPickerDialog } from '../projects/PathPickerDialog'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export interface AddSkillSource { source: string; target?: string }

export function AddSkillDialog({ initial, onClose, onInstalled }: {
  initial: AddSkillSource
  onClose(): void
  onInstalled(result: SkillInstallResult): void
}) {
  const t = useT()
  const id = useId()
  const [source, setSource] = useState(initial.source)
  const [probe, setProbe] = useState<SkillProbe | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<SkillInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const request = useRef(0)
  const token = useRef<string | null>(null)
  const working = useRef(false)
  const mounted = useRef(true)

  const scan = async (value: string, target?: string) => {
    if (!value.trim() || working.current) return
    working.current = true
    const current = ++request.current
    setScanning(true)
    setError(null)
    setResult(null)
    setProbe(null)
    if (token.current) void api.discardSkillProbe(token.current).catch(() => {})
    token.current = null
    try {
      const next = await api.probeSkills(value.trim())
      if (!mounted.current || current !== request.current) {
        void api.discardSkillProbe(next.token).catch(() => {})
        return
      }
      token.current = next.token
      setProbe(next)
      const fresh = next.candidates.filter((candidate) => !candidate.installed)
      const matches = target ? fresh.filter((candidate) => candidate.name === target || candidate.path.split('/').at(-2) === target) : []
      setPicked(new Set((target ? matches : fresh.length <= 3 ? fresh : []).map((candidate) => candidate.path)))
    } catch (failure) { if (mounted.current && current === request.current) setError(errorText(failure)) }
    finally {
      if (current === request.current) {
        working.current = false
        if (mounted.current) setScanning(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    if (initial.source) void scan(initial.source, initial.target)
    return () => {
      mounted.current = false
      working.current = false
      request.current++
      if (token.current) void api.discardSkillProbe(token.current).catch(() => {})
    }
  }, [])

  const install = async () => {
    if (!probe || !picked.size || working.current) return
    working.current = true
    setInstalling(true)
    setError(null)
    try {
      const next = await api.installSkills(probe.token, [...picked])
      token.current = null
      if (!mounted.current) return
      setResult(next)
      onInstalled(next)
      if (!next.skipped.length) onClose()
    } catch (failure) {
      token.current = null
      if (mounted.current) { setError(`${errorText(failure)} ${t('skills.expiredHint')}`); setProbe(null) }
    } finally { working.current = false; if (mounted.current) setInstalling(false) }
  }
  const fresh = probe?.candidates.filter((candidate) => !candidate.installed) ?? []
  const all = fresh.length > 0 && fresh.every((candidate) => picked.has(candidate.path))

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !installing) onClose() }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('skills.add')}</DialogTitle>
          <DialogDescription>{t('skills.sourceHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-0.5">
          <form onSubmit={(event) => { event.preventDefault(); void scan(source) }}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-source`}>{t('skills.source')}</FieldLabel>
                <InputGroup>
                  <InputGroupInput id={`${id}-source`} value={source} onChange={(event) => setSource(event.target.value)} placeholder={t('skills.sourcePlaceholder')} disabled={scanning || installing} />
                  <InputGroupAddon><Search /></InputGroupAddon>
                </InputGroup>
              </Field>
              <div className="flex items-center justify-between gap-2">
                <Button type="button" size="sm" variant="outline" disabled={scanning || installing} onClick={() => setPicking(true)}><FolderOpen data-icon="inline-start" />{t('skills.chooseDirectory')}</Button>
                <Button type="submit" size="sm" disabled={!source.trim() || scanning || installing}>
                  {scanning ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Search data-icon="inline-start" />}
                  {t(scanning ? 'skills.scanning' : 'skills.scan')}
                </Button>
              </div>
            </FieldGroup>
          </form>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {probe ? (
            probe.candidates.length ? (
              <FieldSet disabled={installing || !!result}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLegend variant="label" className="mb-0">{t('skills.preview', { n: probe.candidates.length })}</FieldLegend>
                  <Button type="button" variant="ghost" size="xs" disabled={!fresh.length || installing || !!result} onClick={() => setPicked(new Set(all ? [] : fresh.map((candidate) => candidate.path)))}>{t(all ? 'skills.selectNone' : 'skills.selectAll')}</Button>
                </div>
                <FieldGroup className="gap-0 overflow-hidden rounded-lg border">
                  {probe.candidates.map((candidate, index) => (
                    <Field key={candidate.path} orientation="horizontal" data-disabled={candidate.installed || undefined} className="items-start gap-3 border-b p-3 last:border-b-0">
                      <Checkbox id={`${id}-${index}`} checked={picked.has(candidate.path)} disabled={candidate.installed || installing || !!result} onCheckedChange={(checked) => setPicked((current) => {
                        const next = new Set(current)
                        if (checked) next.add(candidate.path)
                        else next.delete(candidate.path)
                        return next
                      })} className="mt-0.5" />
                      <FieldContent className="gap-1">
                        <FieldLabel htmlFor={`${id}-${index}`} className="flex flex-wrap items-center gap-2">{candidate.name}{candidate.installed ? <Badge variant="secondary">{t('skills.alreadyInstalled')}</Badge> : null}</FieldLabel>
                        <FieldDescription className="line-clamp-2 text-xs">{candidate.description}</FieldDescription>
                        {candidate.diagnostics.map((message) => <p key={message} className="text-xs text-warning">{message}</p>)}
                      </FieldContent>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            ) : <Empty className="border"><EmptyHeader><EmptyTitle>{t('skills.noCandidates')}</EmptyTitle><EmptyDescription>{t('skills.noCandidatesDescription')}</EmptyDescription></EmptyHeader></Empty>
          ) : null}
          {probe?.diagnostics.length ? <Alert><AlertTriangle /><AlertDescription><span>{t('skills.probeIssues')}</span>{probe.diagnostics.map((item, index) => <span key={index} className="break-words">{item.path}: {item.message}</span>)}</AlertDescription></Alert> : null}
          {result ? <Alert><AlertDescription><span>{t('skills.installedCount', { n: result.installed.length })}</span>{result.skipped.map((item) => <span key={item.name}>{t('skills.skipped', item)}</span>)}</AlertDescription></Alert> : null}
          <p className="text-xs leading-relaxed text-muted-foreground">{t('skills.importWarning')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={installing} onClick={onClose}>{t(result ? 'skills.done' : 'skills.cancel')}</Button>
          {!result ? <Button disabled={!probe || !picked.size || installing || scanning} onClick={() => void install()}>
            {installing ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {installing ? t('skills.installing') : t('skills.install', { n: picked.size })}
          </Button> : null}
        </DialogFooter>
        {picking ? <PathPickerDialog
          title={t('skills.chooseDirectory')}
          description={t('skills.chooseDirectoryHint')}
          confirmLabel={t('skills.useDirectory')}
          onClose={() => setPicking(false)}
          onSelect={(path) => { setSource(path); setPicking(false) }}
        /> : null}
      </DialogContent>
    </Dialog>
  )
}
