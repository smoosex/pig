import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Eye, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { PERMISSION_MODES, type PermissionMode, type SandboxStatus, type SessionPermission } from '../../../../shared/permissions'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { InputGroupButton } from '../ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const ICONS: Record<PermissionMode, LucideIcon> = { 'read-only': Eye, default: ShieldCheck, 'full-access': ShieldOff }

/** One icon for the session's permission mode; a dot warns when the mode relies on a sandbox that is not running. */
export function PermissionModeButton({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const [permission, setPermission] = useState<SessionPermission | null>(null)
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [sandboxError, setSandboxError] = useState<string | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    setPermission(null)
    setSandbox(null)
    setPermissionError(null)
    setSandboxError(null)
    if (!sessionId) return
    let current = true
    const load = () => {
      const request = ++revision.current
      // A notification invalidates both snapshots, but failure of one read must not hide the other.
      setPermission(null)
      setSandbox(null)
      setPermissionError(null)
      setSandboxError(null)
      const failed = (failure: unknown, kind: 'permission' | 'sandbox') => {
        if (!current || request !== revision.current) return
        const message = failure instanceof Error ? failure.message : String(failure)
        if (kind === 'permission') setPermissionError(message)
        else setSandboxError(message)
        toast.error(message)
      }
      void api.permissions.getSessionPermission(sessionId).then(
        (next) => { if (current && request === revision.current) setPermission(next) },
        (failure: unknown) => failed(failure, 'permission'))
      void api.permissions.getPermissions().then(
        (snapshot) => { if (current && request === revision.current) setSandbox(snapshot.sandbox) },
        (failure: unknown) => failed(failure, 'sandbox'))
    }
    load()
    const unsubscribe = api.permissions.onPermissionsChanged(load)
    return () => { current = false; revision.current++; unsubscribe() }
  }, [sessionId])

  const choose = (mode: PermissionMode | null) => {
    if (!sessionId) return
    // The main process broadcasts after saving. Reread that state rather than accepting this reply:
    // another window or a newer selection may already have changed the mode.
    void api.permissions.setSessionPermission(sessionId, mode).catch(
      (failure: unknown) => toast.error(failure instanceof Error ? failure.message : String(failure)))
  }

  const mode = permission?.mode
  const Icon = mode ? ICONS[mode] : CircleHelp
  const unprotected = mode !== 'full-access' && sandbox !== null && sandbox.state !== 'ready' && sandbox.state !== 'pending'
  const unknown = t('permissions.sandboxState.pending')
  const modeLabel = mode ? t(`permissions.mode.${mode}`) : `${t('permissions.title')} · ${permissionError ? t('file.readFailed', { error: permissionError }) : unknown}`
  const sandboxLabel = sandboxError ? t('file.readFailed', { error: sandboxError }) : !sandbox ? unknown : null
  const label = `${modeLabel}${sandboxLabel ? ` · ${t('permissions.sandbox')}: ${sandboxLabel}` : unprotected ? ` · ${t('permissions.sandboxOff')}` : ''}`

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <InputGroupButton size="icon-xs" variant="ghost" className="relative rounded-full [&_svg:not([class*='size-'])]:size-3"
              disabled={!sessionId || !permission} aria-label={label}>
              <Icon />
              {unprotected || !sandbox ? <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning" /> : null}
            </InputGroupButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuGroup>
        <DropdownMenuRadioGroup value={mode ?? ''} onValueChange={(value) => choose(value as PermissionMode)}>
          {PERMISSION_MODES.map((item) => {
            const ItemIcon = ICONS[item]
            return (
              <DropdownMenuRadioItem key={item} value={item} className="items-start">
                <ItemIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span>{t(`permissions.mode.${item}`)}</span>
                  <span className="text-xs text-muted-foreground">{t(`permissions.modeHint.${item}`)}</span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={!permission?.overridden} onSelect={() => choose(null)}>
            {t('permissions.followDefault')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('permissions.limitations')}</p>
        {sandboxLabel ? <p className="px-2 py-1.5 text-xs text-warning">{t('permissions.sandbox')}: {sandboxLabel}</p> : null}
        {unprotected ? <p className="px-2 py-1.5 text-xs text-warning">{t('permissions.sandboxMissing', { detail: sandbox?.detail ?? t(`permissions.sandboxState.${sandbox!.state}`) })}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
