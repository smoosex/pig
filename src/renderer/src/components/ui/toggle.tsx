import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Toggle as TogglePrimitive } from "radix-ui"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-glass-prompt-foreground/8 hover:text-glass-prompt-foreground focus-visible:border-ring focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-glass-prompt-foreground/12 data-[state=on]:bg-glass-prompt-foreground/12 solid:hover:bg-accent solid:hover:text-accent-foreground solid:aria-pressed:bg-primary/10 solid:aria-pressed:text-primary solid:data-[state=on]:bg-primary/10 solid:data-[state=on]:text-primary dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        // Segmented: the group is a recessed track and the pressed item a raised glass button.
        outline: "border border-transparent bg-transparent hover:bg-glass-prompt-foreground/6 data-[state=on]:border-glass-button-border data-[state=on]:bg-glass-button-background data-[state=on]:bg-[image:var(--glass-button-sheen)] data-[state=on]:text-glass-prompt-foreground data-[state=on]:shadow-glass-button data-[state=on]:hover:bg-glass-button-hover-background solid:hover:bg-foreground/6 solid:data-[state=on]:border-border solid:data-[state=on]:bg-background solid:data-[state=on]:bg-none solid:data-[state=on]:text-foreground solid:data-[state=on]:shadow-sm solid:data-[state=on]:hover:bg-background",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 min-w-6 rounded-[min(var(--radius-md),12px)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
