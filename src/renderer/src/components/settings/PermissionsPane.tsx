import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { PERMISSION_MODES, type PermissionMode, type PermissionsSnapshot } from '../../../../shared/permissions'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsCard, SettingsRow } from './SettingsFields'

/** A project is stored by its Git common directory; the repository folder reads better. */
function projectLabel(root: string): string {
  return root.replace(/[/\\]\.git$/, '')
}

function Heading({ children }: { children: string }) {
  return <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</p>
}

export function PermissionsPane() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const locked = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    const load = () => {
      const request = ++revision.current
      void api.permissions.getPermissions().then(
        (next) => { if (mounted.current && request === revision.current) setSnapshot(next) },
        (failure: unknown) => { if (mounted.current && request === revision.current) setError(failure instanceof Error ? failure.message : String(failure)) }
      )
    }
    load()
    const unsubscribe = api.permissions.onPermissionsChanged(load)
    return () => { mounted.current = false; revision.current++; unsubscribe() }
  }, [])

  const run = (operation: () => Promise<PermissionsSnapshot>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    const request = ++revision.current
    void operation().then(
      (next) => { if (mounted.current && request === revision.current) setSnapshot(next) },
      (failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    ).finally(() => {
      locked.current = false
      if (mounted.current) setBusy(false)
    })
  }

  if (!snapshot) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null
  const { sandbox } = snapshot
  const hosts = [
    ...snapshot.domains.map((domain) => ({ project: null, label: t('permissions.allProjects'), domain })),
    ...snapshot.projects.flatMap((project) => project.domains.map((domain) => ({ project: project.root, label: projectLabel(project.root), domain })))
  ]

  return (
    <div className="flex flex-col gap-8">
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div>
        <Heading>{t('permissions.sandbox')}</Heading>
        <SettingsCard>
          <SettingsRow title={t(`permissions.sandboxState.${sandbox.state}`)} description={sandbox.detail ?? t('permissions.sandboxDescription')}>
            <span className={cn('text-xs', sandbox.state === 'ready' ? 'text-success' : 'text-warning')}>
              {t(sandbox.state === 'ready' ? 'permissions.sandboxOn' : 'permissions.sandboxOff')}
            </span>
          </SettingsRow>
        </SettingsCard>
        <p className="mt-2 text-xs text-muted-foreground">{t('permissions.limitations')}</p>
      </div>
      <div>
        <Heading>{t('permissions.modes')}</Heading>
        <SettingsCard>
          <SettingsRow title={t('permissions.defaultMode')} description={t('permissions.defaultModeDescription')}>
            <Select disabled={busy} value={snapshot.defaultMode} onValueChange={(mode) => run(() => api.permissions.setDefaultPermissionMode(mode as PermissionMode))}>
              <SelectTrigger size="sm" aria-label={t('permissions.defaultMode')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  {PERMISSION_MODES.map((mode) => <SelectItem key={mode} value={mode}>{t(`permissions.mode.${mode}`)}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <Heading>{t('permissions.hosts')}</Heading>
        <SettingsCard>
          {hosts.length ? hosts.map(({ project, label, domain }) => (
            <div key={`${project ?? ''}\0${domain}`} className="flex items-center gap-3 px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{domain}</div>
                <div className="truncate text-xs text-muted-foreground">{label}</div>
              </div>
              <Button variant="ghost" size="icon-xs" disabled={busy} aria-label={t('permissions.removeHost', { host: domain })}
                onClick={() => run(() => api.permissions.removePermissionDomain(project, domain))}>
                <X />
              </Button>
            </div>
          )) : <p className="px-4 py-3 text-xs text-muted-foreground">{t('permissions.noHosts')}</p>}
        </SettingsCard>
      </div>
    </div>
  )
}
