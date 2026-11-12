import * as React from "react"

import { cn } from "@/lib/utils"
import { inputSurface } from "@/components/ui/input-surface"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border px-2.5 py-2 text-base transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        inputSurface,
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
