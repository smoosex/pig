/** Shared filename filter; file-tree actions sit beside, not inside, the search field. */
import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'

export function WorkspaceFilter({ label, value, onChange, disabled, children }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; children?: ReactNode
}) {
  return <div className="flex shrink-0 items-center gap-1 px-1 pb-2" data-workspace-filter>
    <InputGroup className="h-6 rounded-full border-transparent bg-sidebar-foreground/6 shadow-none solid:bg-sidebar-accent">
      <InputGroupInput className="h-6 text-xs md:text-xs" aria-label={label} placeholder={label} value={value} maxLength={500}
        disabled={disabled} onChange={event => onChange(event.target.value)} />
      <InputGroupAddon><Search className="size-3.5" /></InputGroupAddon>
    </InputGroup>
    {children}
  </div>
}
