import * as React from 'react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn('peer flex size-4 shrink-0 items-center justify-center rounded-sm border border-glass-button-border bg-glass-button-background bg-[image:var(--glass-button-sheen)] shadow-glass-inline-code outline-none transition-[background-color,border-color,box-shadow] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:bg-none solid:border-input solid:bg-background solid:bg-none solid:shadow-none solid:data-[state=checked]:border-primary solid:data-[state=checked]:bg-primary', className)} {...props}>
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center [&>svg]:size-3.5">
        <Check />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
