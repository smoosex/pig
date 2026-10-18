import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-5', className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn('inline-flex h-9 w-fit items-center gap-1 rounded-lg bg-glass-prompt-foreground/6 p-1 text-muted-foreground solid:bg-muted', className)} {...props} />
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn('inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-glass-button-hover-background data-[state=active]:bg-[image:var(--glass-button-sheen)] data-[state=active]:text-glass-prompt-foreground data-[state=active]:shadow-glass-button [&_svg]:size-3.5 solid:data-[state=active]:bg-background solid:data-[state=active]:bg-none solid:data-[state=active]:text-foreground solid:data-[state=active]:shadow-xs', className)} {...props} />
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex min-w-0 flex-col gap-5 outline-none', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
