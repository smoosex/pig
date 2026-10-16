import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const glassButtonSurface = "bg-[image:var(--glass-button-sheen)] shadow-glass-button hover:shadow-glass-button-hover aria-expanded:shadow-glass-button-hover solid:bg-none solid:shadow-none solid:hover:shadow-none solid:aria-expanded:shadow-none"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all motion-reduce:transition-none outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary bg-clip-border text-primary-foreground shadow-glass-primary-button hover:bg-primary solid:bg-clip-padding solid:shadow-none solid:hover:bg-primary/80",
        outline: [
          glassButtonSurface,
          "border-glass-button-border bg-glass-button-background text-glass-prompt-foreground hover:bg-glass-button-hover-background aria-expanded:bg-glass-button-hover-background solid:border-border solid:bg-background solid:text-foreground solid:hover:bg-muted solid:aria-expanded:bg-muted solid:dark:border-input solid:dark:bg-input/30 solid:dark:hover:bg-input/50"
        ],
        secondary: [
          glassButtonSurface,
          "border-glass-button-border bg-glass-button-background text-glass-prompt-foreground hover:bg-glass-button-hover-background aria-expanded:bg-glass-button-hover-background solid:border-transparent solid:bg-secondary solid:text-secondary-foreground solid:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] solid:aria-expanded:bg-secondary solid:aria-expanded:text-secondary-foreground"
        ],
        ghost:
          "hover:bg-glass-button-hover-background hover:text-glass-prompt-foreground aria-expanded:bg-glass-button-hover-background aria-expanded:text-glass-prompt-foreground solid:hover:bg-muted solid:hover:text-foreground solid:aria-expanded:bg-muted solid:aria-expanded:text-foreground solid:dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
