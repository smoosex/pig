/** The material switch is a single lens orb showing the current style; the reveal grows from it. */
import { Droplet, Square } from 'lucide-react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import type { SurfaceStyle } from '../../../../shared/api'
import { setSurfaceRevealOrigin } from '../../lib/surface-transition'
import { cn } from '../../lib/utils'

const fade = 'transition-[opacity,scale,rotate] duration-300 ease-in-out motion-reduce:transition-none'

export function SurfaceStyleToggle({ value, onChange, ...props }: {
  value: SurfaceStyle
  onChange: (value: SurfaceStyle) => void
} & Omit<ComponentProps<typeof SwitchPrimitive.Root>, 'checked' | 'onCheckedChange' | 'onChange' | 'value'>) {
  const glass = value === 'glass'
  return (
    <SwitchPrimitive.Root
      {...props}
      checked={glass}
      onClick={(event) => setSurfaceRevealOrigin(event.currentTarget)}
      onCheckedChange={(checked) => onChange(checked ? 'glass' : 'solid')}
      className="relative flex size-5.5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-glass-orb-background bg-[image:var(--glass-orb-sheen)] text-glass-prompt-foreground shadow-glass-orb outline-none transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring motion-reduce:transition-none solid:bg-background solid:bg-none solid:text-foreground solid:shadow-none solid:ring-1 solid:ring-sidebar-border"
    >
      <Droplet aria-hidden="true" className={cn('absolute size-3', fade, glass ? 'opacity-100' : 'scale-40 rotate-30 opacity-0')} />
      <Square aria-hidden="true" className={cn('absolute size-2.5', fade, glass ? 'scale-40 -rotate-45 opacity-0' : 'opacity-100')} />
    </SwitchPrimitive.Root>
  )
}
