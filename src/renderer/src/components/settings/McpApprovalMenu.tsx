/** Per-server MCP approval, stored in Pig's permissions file where the Agent cannot change it. */
import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, ShieldOff, ShieldQuestionMark, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { MCP_APPROVALS, type McpApproval } from '../../../../shared/permissions'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Button } from '../ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const ICONS: Record<McpApproval, LucideIcon> = { auto: ShieldCheck, prompt: ShieldQuestionMark, approve: ShieldOff }

/** Every server's approval; null until the first read. Follows changes from any window. */
export function useMcpApprovals(): [Record<string, McpApproval> | null, (next: Record<string, McpApproval>) => void] {
  const [approvals, setApprovals] = useState<Record<string, McpApproval> | null>(null)
  const revision = useRef(0)
  useEffect(() => {
    const read = () => {
      const current = ++revision.current
      api.permissions.getPermissions().then(
        (snapshot) => { if (current === revision.current) setApprovals(snapshot.mcp) },
        (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
    }
    read()
    return api.permissions.onPermissionsChanged(read)
  }, [])
  return [approvals, (next) => { revision.current++; setApprovals(next) }]
}

export function McpApprovalMenu({ name, approvals, disabled, onChange }: {
  name: string
  approvals: Record<string, McpApproval> | null
  disabled: boolean
  onChange(next: Record<string, McpApproval>): void
}) {
  const t = useT()
  const [saving, setSaving] = useState(false)
  const value = approvals?.[name] ?? 'auto'
  const Icon = ICONS[value]
  const label = `${t('permissions.mcpApproval')} ${name}: ${t(`permissions.mcpApprovals.${value}`)}`
  const choose = (next: string) => {
    if (next === value || !(MCP_APPROVALS as readonly string[]).includes(next)) return
    setSaving(true)
    api.permissions.setMcpApproval(name, next as McpApproval).then(
      (snapshot) => onChange(snapshot.mcp),
      (error: unknown) => toast.error(error instanceof Error ? error.message : String(error))
    ).finally(() => setSaving(false))
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={label} disabled={disabled || saving || approvals === null}>
              <Icon data-icon="inline-start" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64"
        // Returning focus to the trigger would open its Tooltip and leave it up after a choice.
        onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('permissions.mcpApprovalDescription')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={choose}>
            {MCP_APPROVALS.map((item) => {
              const ItemIcon = ICONS[item]
              return (
                <DropdownMenuRadioItem key={item} value={item}>
                  <ItemIcon />
                  {t(`permissions.mcpApprovals.${item}`)}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
